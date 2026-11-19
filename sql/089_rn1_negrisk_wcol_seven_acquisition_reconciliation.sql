-- Evidence-backed repair for the seven RN1 September acquisition receipts on
-- neg-risk CA Rosario Central. Run after 085-087 and acquisition batch v2.
-- Collateral candidate IDs were independently derived via Polygon CTF
-- getCollectionId(0,conditionId,[1,2]) + getPositionId(collateral,collectionId).
-- Only WCOL 0x3a3b...2e2 matches the exact ERC1155 token IDs directly received.
do $repair$
declare n integer; already_fixed integer;
begin
 select count(*) into already_fixed from pi.rn1_chain_acquisition_queue
 where audit_note='exact_pusd_and_ctf_token_under_negrisk_wcol_confirmed'
   and market_key='0x6c515212fc82b7902a86eb16f4c9d2890a2cdc3e3e3344743a75aa99a353ed16';
 if already_fixed=7 then return; end if;
 select count(*) into n
 from pi.rn1_chain_acquisition_queue q
 where q.market_key='0x6c515212fc82b7902a86eb16f4c9d2890a2cdc3e3e3344743a75aa99a353ed16'
  and q.audit_status='ambiguous'
  and q.source_fill_count=1 and array_length(q.source_outcomes,1)=1
  and (q.audit_evidence->>'cash_match')::boolean
  and abs(q.observed_pusd_debit-q.archived_cost)<0.000002
  and jsonb_array_length(q.audit_evidence->'wallet_pusd_out_transfers')=1
  and jsonb_array_length(q.audit_evidence->'wallet_erc1155_transfers')=1
  and jsonb_array_length(q.audit_evidence->'wallet_usdce_transfers')=0
  and lower(q.audit_evidence->'wallet_erc1155_transfers'->0->>'to')='0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
  and abs((q.audit_evidence->'wallet_erc1155_transfers'->0->>'micro')::numeric/1000000-q.archived_shares)<0.000002
  and (q.audit_evidence->'wallet_erc1155_transfers'->0->>'tokenId')=case q.source_outcomes[1]
      when 0 then '18121526519433407266049544818887643036354529288334070851910186010177792112199'
      when 1 then '44225980113333392068784161275839701879733186897398900375077580133170980044078'
      else null end;
 if n<>7 then raise exception 'Expected exactly seven receipt-verified WCOL transfers; got %',n; end if;
 update pi.rn1_chain_token_map set
  position_token0='18121526519433407266049544818887643036354529288334070851910186010177792112199',
  position_token1='44225980113333392068784161275839701879733186897398900375077580133170980044078',
  mapping_method='Polygon CTF getCollectionId/getPositionId; neg-risk WCOL 0x3a3bd7bb9528e159577f7c2e685cc81a765002e2',
  updated_at=now()
 where market_key='0x6c515212fc82b7902a86eb16f4c9d2890a2cdc3e3e3344743a75aa99a353ed16';
 if not found then raise exception 'No existing token mapping'; end if;
 update pi.rn1_chain_acquisition_queue q set
  audit_status='verified',
  audit_note='exact_pusd_and_ctf_token_under_negrisk_wcol_confirmed',
  observed_shares_received=archived_shares,
  audit_lease_until=null,last_checked_at=now(),
  audit_evidence=q.audit_evidence || jsonb_build_object(
   'position_collateral','NEG_RISK_WCOL',
   'position_collateral_address','0x3a3bd7bb9528e159577f7c2e685cc81a765002e2',
   'position_mapping_verified_onchain',true,
   'original_usdce_position_mapping_invalid_for_this_market',true,
   'expected_token_id',case q.source_outcomes[1]
    when 0 then '18121526519433407266049544818887643036354529288334070851910186010177792112199'
    when 1 then '44225980113333392068784161275839701879733186897398900375077580133170980044078' end,
   'observed_expected_token_net',to_char(q.archived_shares,'FM999999999990.000000'),
   'shares_match',true)
 where q.market_key='0x6c515212fc82b7902a86eb16f4c9d2890a2cdc3e3e3344743a75aa99a353ed16'
  and q.audit_status='ambiguous';
 get diagnostics n=row_count;
 if n<>7 then raise exception 'Unexpected repair row count %',n; end if;
end $repair$;