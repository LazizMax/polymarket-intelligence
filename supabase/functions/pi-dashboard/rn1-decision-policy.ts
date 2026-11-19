// RN1 decision-policy readouts. Private authenticated dashboard routes; no chain writes.
export async function rn1SignedLimitOofReport(db:any){
 const [s,e,folds]=await Promise.all([
   db.unsafe(`select count(*)::integer orders,count(distinct event_slug)::integer events,
    count(distinct event_fold)::integer folds,
    round(avg(abs_error_m0)::numeric,6)::float8 mae_m0,
    round(avg(abs_error_m1)::numeric,6)::float8 mae_m1,
    round(avg(abs_error_m2)::numeric,6)::float8 mae_m2,
    round(avg(abs_error_m3)::numeric,6)::float8 mae_m3
    from pi.rn1_maker_signed_limit_oof_v1`),
   db.unsafe(`with e as (
       select event_slug,
       avg(abs_error_m0) m0,avg(abs_error_m1) m1,
       avg(abs_error_m2) m2,avg(abs_error_m3) m3
       from pi.rn1_maker_signed_limit_oof_v1 group by event_slug
     )
     select count(*)::integer events,
     round(avg(m0-m1)::numeric,6)::float8 event_delta_m1_over_m0,
     round(avg(m1-m2)::numeric,6)::float8 event_delta_m2_over_m1,
     round(avg(m1-m3)::numeric,6)::float8 event_delta_m3_over_m1,
     round((1.96*stddev_samp(m0-m1)/sqrt(count(*)))::numeric,6)::float8 paired_normal_halfwidth_m1,
     round((1.96*stddev_samp(m1-m2)/sqrt(count(*)))::numeric,6)::float8 paired_normal_halfwidth_m2,
     count(*) filter(where m1<m0)::integer improved_events_m1,
     count(*) filter(where m2<m1)::integer improved_events_m2
     from e`),
   db.unsafe(`select event_fold,count(*)::integer orders,count(distinct event_slug)::integer events,
     round(avg(abs_error_m0)::numeric,6)::float8 mae_m0,
     round(avg(abs_error_m1)::numeric,6)::float8 mae_m1,
     round(avg(abs_error_m2)::numeric,6)::float8 mae_m2,
     round(avg(abs_error_m3)::numeric,6)::float8 mae_m3,
     round(avg(train_global_gap)::numeric,5)::float8 learned_median_gap
     from pi.rn1_maker_signed_limit_oof_v1 group by event_fold order by event_fold`)
 ]);
 return {
  status:"event_disjoint_cross_validation_completed",
  summary:s[0]||{},event_level:e[0]||{},folds,
  interpretation:"The simple signed buy limit offset outperforms no-offset on selected executed signed orders. Momentum is not statistically established over constant offset.",
  limitations:[
   "November 2026 781 executed signed BUY orders in 503 events only; all never-filled Maker orders are absent.",
   "Historical price points were retrieved retrospectively and are not authenticated live bid/ask snapshots.",
   "Event folds are internal cross-validation, not the disjoint external 376-order November holdout.",
   "MAE predicts signed limit PRICE, not the probability of placing an order, actual fill quality, net ROI or execution feasibility.",
   "Normal 95% event-cluster intervals are approximate; 400-replicate deterministic event bootstrap is documented separately."
  ]
 };
}

export async function rn1ChainCashflowPanelReport(db:any){
 const rows=await db.unsafe(`with purchases as (
   select market_key,count(*)::integer buys,
     count(*) filter(where audit_status='verified')::integer verified_buys,
     coalesce(sum(archived_cost),0) archived_buy_cost,
     coalesce(sum(observed_pusd_debit) filter(where audit_status='verified'),0) observed_buy_debit
   from pi.rn1_chain_acquisition_queue group by market_key
  ), panel as (
   select h.market_key,h.title,h.cohort,h.source_trade_fills,
     p.buys,p.verified_buys,p.archived_buy_cost,p.observed_buy_debit,
     s.direct_pusd_merge_credit,s.direct_pusd_redeem_credit,
     (s.direct_pusd_merge_credit+s.direct_pusd_redeem_credit) verified_credits,
     (p.verified_buys=p.buys
       and abs(p.archived_buy_cost-p.observed_buy_debit)<.000002
       and abs(h.buy_spend-p.observed_buy_debit)<.000002
       and h.sell_proceeds=0 and abs(h.terminal0)<.000002 and abs(h.terminal1)<.000002
       and s.direct_pusd_all_credits_matched and s.fully_correlated
     ) all_supported
   from pi.rn1_ledger_holdout_audit h
   join purchases p using(market_key)
   join pi.rn1_chain_settlement_audit s using(market_key)
  )
  select market_key,title,cohort,source_trade_fills,buys,verified_buys,all_supported,
   round(observed_buy_debit,6)::float8 debit_pusd,
   round(verified_credits,6)::float8 credit_pusd,
   case when all_supported then round(verified_credits-observed_buy_debit,6)::float8 end gross_cash_net,
   case when all_supported then round(100*(verified_credits-observed_buy_debit)/nullif(observed_buy_debit,0),4)::float8 end gross_return_pct
  from panel order by cohort,title`);
 const cohorts:Record<string,{markets:number;verified:number;buy:number;credits:number;gross:number}>={};
 for(const r of rows){
   const name=String(r.cohort);
   const c=cohorts[name] ||= {markets:0,verified:0,buy:0,credits:0,gross:0};
   c.markets++;
   if(r.all_supported){
     c.verified++;
     c.buy+=Number(r.debit_pusd||0);
     c.credits+=Number(r.credit_pusd||0);
     c.gross+=Number(r.gross_cash_net||0);
   }
 }
 const allVerified=rows.length===8&&rows.every((r:any)=>r.all_supported);
 const summary=Object.values(cohorts).reduce((x,c)=>({
   markets:x.markets+c.markets,verified:x.verified+c.verified,
   buys:x.buys+c.buy,credits:x.credits+c.credits,gross:x.gross+c.gross
 }),{markets:0,verified:0,buys:0,credits:0,gross:0});
 return {
   status:allVerified?"fully_reconciled_gross_cash_only":"partial_cash_reconciliation",
   summary:{...summary,gross_roi_pct:summary.buys?100*summary.gross/summary.buys:null},
   cohorts,markets:rows,
   scope:"Independently selected eight September 2026 settled markets, not overlapping the November signed Maker cohort.",
   limitation:"Gross direct wallet cash movement only. No fees/rebates, indirect gas, outside-position transfers, or proof that these particular September buys were Maker; do not infer RN1's full wallet net ROI."
 };
}


export async function rn1MakerPrecreationFlowReport(db:any){
 const [coverage,models,cohorts,regimes,integrity]=await Promise.all([
  db.unsafe(`select
    count(*)::integer signed_orders,
    count(distinct event_slug)::integer events,
    count(*) filter(where valid_signed_limit_reference)::integer valid_historical_price,
    count(*) filter(where maker_count_5m>0)::integer recent_maker_5m,
    count(*) filter(where maker_count_30m>0)::integer recent_maker_30m,
    count(*) filter(where same_maker_shares_5m>0)::integer recent_same_side_5m,
    count(*) filter(where opposite_maker_shares_5m>0)::integer recent_opposite_side_5m,
    count(*) filter(where last_any_maker_at>=declared_created_at or last_same_maker_at>=declared_created_at)::integer future_fill_leakage
   from pi.rn1_maker_signed_precreation_flow_v1`),
  db.unsafe(`with by_event as (
    select validation_group,event_slug,count(*)::integer orders,
      avg(abs_error_constant) constant_mae,avg(abs_error_flow) flow_mae
    from pi.rn1_maker_flow_policy_validation_v1
    group by validation_group,event_slug
   ),event_summary as (
    select validation_group,count(*)::integer events,
     round(avg(constant_mae)::numeric,6)::float8 event_mae_constant,
     round(avg(flow_mae)::numeric,6)::float8 event_mae_flow,
     round(avg(constant_mae-flow_mae)::numeric,6)::float8 event_gain,
     round((1.96*stddev_samp(constant_mae-flow_mae)/sqrt(count(*)))::numeric,6)::float8 normal_95_halfwidth,
     count(*) filter(where flow_mae<constant_mae)::integer improved_events
    from by_event group by validation_group
   )
   select m.validation_group,count(*)::integer orders,count(distinct m.event_slug)::integer events,
     round(avg(m.abs_error_constant)::numeric,6)::float8 mae_constant,
     round(avg(m.abs_error_flow)::numeric,6)::float8 mae_flow,
     round(avg(m.abs_error_constant-m.abs_error_flow)::numeric,6)::float8 order_gain,
     e.event_mae_constant,e.event_mae_flow,e.event_gain,e.normal_95_halfwidth,e.improved_events
   from pi.rn1_maker_flow_policy_validation_v1 m
   join event_summary e using(validation_group)
   group by m.validation_group,e.event_mae_constant,e.event_mae_flow,e.event_gain,e.normal_95_halfwidth,e.improved_events
   order by m.validation_group`),
  db.unsafe(`select validation_group,sampled_cohort,
    count(*)::integer orders,count(distinct event_slug)::integer events,
    round(avg(abs_error_constant)::numeric,6)::float8 mae_constant,
    round(avg(abs_error_flow)::numeric,6)::float8 mae_flow
   from pi.rn1_maker_flow_policy_validation_v1
   group by validation_group,sampled_cohort order by validation_group,sampled_cohort`),
  db.unsafe(`select validation_group,flow_regime_5m,
    count(*)::integer orders,
    round(avg(train_gap)::numeric,5)::float8 learned_constant_gap,
    round(avg(flow_gap)::numeric,5)::float8 learned_flow_gap
   from pi.rn1_maker_flow_policy_validation_v1
   group by validation_group,flow_regime_5m order by validation_group,flow_regime_5m`),
  db.unsafe(`select
     (select count(*)::integer from pi.rn1_maker_flow_policy_validation_v1 h
       where h.validation_group='new_event_targeted_holdout' and exists(
         select 1 from pi.rn1_maker_flow_policy_validation_v1 r
         where r.validation_group='reference_oof' and r.event_slug=h.event_slug
       )) as holdout_event_leaks,
     (select count(*)::integer from pi.rn1_maker_signed_precreation_flow_v1
       where last_any_maker_at>=declared_created_at or last_same_maker_at>=declared_created_at
     ) as temporal_leaks,
     (select count(*)::integer from pi.rn1_maker_flow_policy_validation_v1
       where validation_group='reference_oof' and
         (event_fold<>mod(abs(hashtext(event_slug)::bigint),5))
     ) as fold_errors`)
 ]);
 const strictOk=integrity[0]?.holdout_event_leaks===0&&integrity[0]?.temporal_leaks===0&&integrity[0]?.fold_errors===0;
 return {
  status:strictOk?"precreation_flow_h11_test_completed":"audit_failed",
  coverage:coverage[0]||{},models,cohorts,regimes,integrity:integrity[0]||{},
  verdict:"No observed improvement from a simple 5-minute prior Maker BUY-flow class over the existing fixed signed-limit offset.",
  limitations:[
   "Observed prior fills are a partial BUY-only archive, never full inventory; absence of a fill is not absence of holdings or an unfilled order.",
   "Strictly prior to the DECLARED signature timestamp, which is not an independently proven public book placement timestamp.",
   "242 orders held out by event come from specifically sampled multi-level and persistent-order cohorts, unlike the random_tx reference cohort.",
   "The experiment predicts signed limit prices on already-executed orders, not order submission, non-submission, queue placement, copyable fills, or net ROI."
  ]
 };
}
