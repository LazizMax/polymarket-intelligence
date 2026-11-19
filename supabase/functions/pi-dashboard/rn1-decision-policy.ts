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
