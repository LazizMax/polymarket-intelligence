"""Historical-only interactive research views for Polymarket V1.8."""
from __future__ import annotations
import json
import pandas as pd
import plotly.express as px
import streamlit as st
from historical_intelligence import sector_report,event_ledger,wallet_fingerprint,short_list,wallet_roi_report
from historical_discovery import candidates
from historical_db import wallet_summaries


def nice(w,names):
    return ((names.get(w) or '')+' · ' if names.get(w) else '')+w[:7]+'…'+w[-5:]


def fmt_money(v):
    return f'{v:,.2f} USDC'.replace(',',' ') if v is not None else '—'


def csv_export(df:pd.DataFrame):
    frame=df.copy()
    for c in frame.columns:
        if pd.api.types.is_object_dtype(frame[c]):
            frame[c]=frame[c].map(lambda x: "'"+x if isinstance(x,str) and x.lstrip().startswith(('=','+','-','@')) else x)
    return ('\ufeff'+frame.to_csv(index=False)).encode('utf-8')


def explorer(db):
    st.title('Classement historique avancé')
    st.caption('Compare les spécialistes par secteur, sur la base des positions clôturées effectivement sauvegardées.')
    all_rows=sector_report(db)
    if not all_rows:
        st.info('Pas encore de positions clôturées. Ajoute des wallets dans « Découvrir » ou « Actualisation ».')
        return
    names={r['wallet']:r['name'] for r in wallet_summaries(db)}
    st.warning('Attention : ce sont les wallets de ta base, pas un classement exhaustif de Polymarket. Des historiques ou des coûts manquants rendent certains ratios indisponibles.')
    a,b,c=st.columns([1.3,1,1])
    with a:sector=st.selectbox('Marché / secteur',['Tous les secteurs']+sorted({r['secteur'] for r in all_rows}))
    with b:min_event=st.select_slider('Événements distincts minimum',[1,5,10,20,30,50,100],value=10)
    with c:complete=st.checkbox('Historiques clos complets uniquement',value=False)
    df=pd.DataFrame(all_rows)
    if sector!='Tous les secteurs':df=df[df.secteur==sector]
    df=df[df.evenements_distincts>=min_event]
    if complete:df=df[df['historique_clos_terminé']]
    if df.empty:st.info('Aucun profil ne correspond à ces filtres.');return
    df=df.copy();df['Trader']=df.wallet.map(lambda w:nice(w,names))
    mode=st.radio('Classer les traders par',[
        'ROI sur mises (clôturées)','Profit absolu','Gains médians par événement','Robustesse exploratoire'],horizontal=True)
    choices={'Profit absolu':'pnl_usdc',
             'ROI sur mises (clôturées)':'pnl_sur_cout_entree_pct_pas_roi_capital',
             'Gains médians par événement':'gain_median_par_evenement_usdc',
             'Robustesse exploratoire':'borne_basse_moyenne_evenement_usdc_exploratoire'}
    field=choices[mode]
    if mode=='ROI sur mises (clôturées)':
        st.info('Profit des positions clôturées / somme des coûts d’entrée incluant les frais lorsque le champ est complet. Ce n’est PAS un ROI sur capital, ni un rendement annualisé.')
    if mode=='Robustesse exploratoire':
        st.info('Borne basse bootstrap sur le profit moyen par événement (minimum 30 événements). Non corrigée pour la sélection de nombreux wallets, et ne prouve pas un avantage futur.')
    df=df.sort_values(field,ascending=False,na_position='last')
    render=['Trader','secteur','pnl_usdc','evenements_distincts','taux_evenements_gagnants_pct',
        'pnl_sur_cout_entree_pct_pas_roi_capital','gain_median_par_evenement_usdc',
        'part_du_plus_gros_gain_pct','part_classification_fiable_pct',
        'borne_basse_moyenne_evenement_usdc_exploratoire','historique_clos_terminé']
    st.dataframe(df[render],use_container_width=True,hide_index=True,column_config={
        'pnl_usdc':'PnL clôturé USDC', 'secteur':'Secteur','evenements_distincts':'Événements',
        'taux_evenements_gagnants_pct':'Événements gagnants (%)',
        'pnl_sur_cout_entree_pct_pas_roi_capital':'ROI mises clôturées (%)',
        'gain_median_par_evenement_usdc':'Médiane événement USDC',
        'part_du_plus_gros_gain_pct':'Gros gain / gains positifs (%)',
        'part_classification_fiable_pct':'Tags officiels / manuels (%)',
        'borne_basse_moyenne_evenement_usdc_exploratoire':'Borne basse / événement USDC',
        'historique_clos_terminé':'Historique clos complet'})
    st.download_button('Exporter ce classement (CSV)',csv_export(df[render]),
                       file_name='classement_historique_v18.csv',mime='text/csv')
    st.markdown('### Les traders à examiner en priorité')
    shortlisted=short_list(db,sector=None if sector=='Tous les secteurs' else sector,
                            minimum=max(30,min_event),only_complete=True,
                            max_concentration=60.,min_classification=75.)
    if shortlisted:
        leader=pd.DataFrame(shortlisted[:20]);leader['Trader']=leader.wallet.map(lambda w:nice(w,names))
        st.dataframe(leader[['Trader','secteur','evenements_distincts','pnl_usdc',
            'borne_basse_moyenne_evenement_usdc_exploratoire','part_du_plus_gros_gain_pct']],
            use_container_width=True,hide_index=True)
    else:st.info('Aucun candidat ne satisfait encore les filtres exploratoires : historique clos complet, ≥30 événements, classification ≥75 % et plus gros gain ≤60 % des gains positifs.')
    st.caption('Seuils de présélection arbitraires : ils ne remplacent pas une validation hors échantillon. Un même événement peut appartenir à plusieurs contrats corrélés.')


def advanced_wallet(db):
    st.title('Profil quantitatif détaillé')
    rows=wallet_summaries(db)
    if not rows:st.info('Aucun wallet chargé.');return
    names={r['wallet']:r['name'] for r in rows}
    pick=st.selectbox('Choisir un trader',list(names),format_func=lambda w:nice(w,names))
    f=wallet_fingerprint(db,pick)
    report=sector_report(db,pick)
    roi=wallet_roi_report(db,pick)[0]
    st.markdown('### Retour sur investissement historique')
    x,y,z=st.columns(3)
    x.metric('ROI sur mises clôturées',f"{roi['roi_mises_cloturees_pct']:.2f} %" if roi['roi_mises_cloturees_pct'] is not None else 'Non calculable')
    y.metric('ROI sur mises global (ouvertes incluses)',f"{roi['roi_mises_global_pct']:.2f} %" if roi['roi_mises_global_pct'] is not None else 'Non calculable')
    z.metric('Rendement sur capital réel','Non disponible')
    st.caption('ROI sur mises = somme des PnL des positions / somme de leurs coûts en USDC. Calcul pondéré, jamais une moyenne des pourcentages. Le ROI global inclut les positions ouvertes si leurs historiques sont complets. Ce n’est pas le rendement sur les dépôts du trader.')
    if roi['roi_mises_global_pct'] is None:
        st.warning('ROI global indisponible : historique ouvert/clôturé incomplet, coûts non renseignés ou absence de positions. Actualise ce wallet pour tenter de compléter les données.')
    a,b,c,d=st.columns(4)
    a.metric('Trades historiques observés',f['trades_observes'])
    b.metric('Jours d’activité observés',f['jours_actifs_observes'])
    c.metric('Part achats',f"{f['part_achats_pct']} %" if f['part_achats_pct'] is not None else '—')
    d.metric('Prix médian de transaction',f['prix_mediane'] if f['prix_mediane'] is not None else '—')
    st.caption(f"Période observée : {f['premier_jour'] or '—'} → {f['dernier_jour'] or '—'} (UTC) · Notionnel approximatif des trades récupérés : {fmt_money(f['notionnel_trades_observes_usdc'])}")
    if not next(r for r in rows if r['wallet']==pick)['closed_exhausted']:
        st.warning('Le flux des positions clôturées n’est pas confirmé complet. Les secteurs et ratios ci-dessous reflètent uniquement l’échantillon importé.')
    if not report:st.info('Pas de positions clôturées pour cette fiche.');return
    df=pd.DataFrame(report).sort_values('pnl_usdc',ascending=False)
    st.markdown('### Carte des spécialités')
    left,right=st.columns([1.2,1])
    with left:
        st.plotly_chart(px.bar(df,x='secteur',y='pnl_usdc',color='secteur',
          title='PnL sur positions clôturées par secteur (USDC)'),use_container_width=True)
    with right:
        st.plotly_chart(px.bar(df,x='secteur',y='evenements_distincts',color='secteur',
          title='Événements distincts par secteur'),use_container_width=True)
    display=['secteur','pnl_usdc','evenements_distincts','taux_evenements_gagnants_pct',
             'gain_median_par_evenement_usdc','part_du_plus_gros_gain_pct',
             'pnl_sur_cout_entree_pct_pas_roi_capital','cout_entree_couverture_pct','part_classification_fiable_pct']
    st.dataframe(df[display],hide_index=True,use_container_width=True)
    st.markdown('### Les événements qui expliquent ses résultats')
    ledger=event_ledger(db,pick)
    if ledger:
        ev=pd.DataFrame(ledger);ev=ev.rename(columns={'sector':'Secteur','title':'Marché',
            'pnl_usdc':'PnL USDC','positions':'Positions','pnl_per_entry_cost_pct':'PnL / coût (%)',
            'event_identifier_valid':'Identifiant événement fiable'})
        if len(ev):
            filt=st.selectbox('Secteur des événements',['Tous']+sorted(ev['Secteur'].unique()))
            if filt!='Tous':ev=ev[ev['Secteur']==filt]
            one,two=st.columns(2)
            with one:
                st.markdown('**Plus gros gains**')
                st.dataframe(ev.nlargest(15,'PnL USDC')[['Marché','Secteur','PnL USDC','Positions','PnL / coût (%)']],hide_index=True,use_container_width=True)
            with two:
                st.markdown('**Plus grosses pertes**')
                st.dataframe(ev.nsmallest(15,'PnL USDC')[['Marché','Secteur','PnL USDC','Positions','PnL / coût (%)']],hide_index=True,use_container_width=True)
            st.download_button('Exporter ses événements',csv_export(ev),file_name='wallet_evenements_v18.csv',mime='text/csv')
    st.caption('La date de clôture précise et le PnL par jour/secteur ne sont pas reconstitués ici. Les pourcentages utilisent uniquement les coûts d’entrée explicitement disponibles.')


def discovered_wallets(db):
    st.title('Univers de traders découvert')
    st.caption('Wallets candidats issus des classements Polymarket et d’un échantillon de trades publics récents.')
    all_rows=candidates(db,limit=5000)
    if not all_rows:
        st.info('Aucun candidat découvert. Lance « Découvrir et collecter » dans Historique — Actualisation.')
        return
    total=len(all_rows); collected=sum(x['last_refresh_utc'] is not None for x in all_rows)
    a,b,c=st.columns(3)
    a.metric('Wallets candidats visibles',total)
    b.metric('Historique déjà récupéré',collected)
    c.metric('Candidats à explorer',total-collected)
    df=pd.DataFrame(all_rows)
    df['Sources']=df.source_labels.map(lambda s:', '.join(json.loads(s or '[]')[:4]))
    df['État']=df.last_refresh_utc.map(lambda v:'Historique démarré' if v else 'À collecter')
    st.dataframe(df[['wallet','name','Sources','État','last_seen_utc','last_refresh_utc','closed_exhausted']],
                 hide_index=True,use_container_width=True)
    st.download_button('Exporter les candidats en CSV',csv_export(df[['wallet','name','Sources','État']]),
                       file_name='candidats_wallets_v18.csv',mime='text/csv')
    st.warning('Découverte biaisée : les meilleurs du leaderboard et les wallets du flux des transactions récentes ne représentent pas toute la population. Les PnL affichés sur les classements servent à découvrir, pas à prouver un rendement.')


def global_roi_dashboard(db):
    st.title('ROI global des traders')
    st.caption('Compare les rentabilités historiques pondérées par les mises cumulées, toutes catégories confondues. Les ratios inconnus restent vides.')
    reports=wallet_roi_report(db)
    if not reports:
        st.info('Aucun trader disponible. Va dans Historique — Actualisation pour collecter les historiques.')
        return
    names={r['wallet']:r['name'] for r in reports}
    df=pd.DataFrame(reports)
    df['Trader']=df.wallet.map(lambda w:nice(w,names))
    st.info('ROI sur mises = PnL des positions / somme des coûts d’entrée correspondants. À ne pas confondre avec le rendement du capital ou des dépôts. Les positions ouvertes sont valorisées, pas nécessairement réalisables au prix indiqué.')
    mode=st.radio('Classement principal', ['ROI positions clôturées','ROI global (clôturées + ouvertes)','PnL clôturé'],horizontal=True)
    col={'ROI positions clôturées':'roi_mises_cloturees_pct',
         'ROI global (clôturées + ouvertes)':'roi_mises_global_pct',
         'PnL clôturé':'pnl_cloture_usdc'}[mode]
    min_events=st.select_slider('Nombre minimum d’événements clôturés distincts',[0,5,10,20,30,50,100],value=10)
    only_positive=st.checkbox('Afficher uniquement les rentabilités positives',value=False)
    df=df[df.evenements_clotures>=min_events].copy()
    if only_positive:df=df[df[col]>0]
    df=df.sort_values(col,ascending=False,na_position='last')
    if df.empty:
        st.warning('Aucun trader ne correspond à ces filtres. Réduis le minimum d’événements ou complète les historiques.')
        return
    available=df[col].notna().sum()
    a,b,c=st.columns(3)
    a.metric('Wallets correspondant aux filtres',len(df))
    b.metric('ROI calculable',f'{available}/{len(df)}')
    c.metric('ROI sur capital réel','Non disponible')
    view=['Trader','roi_mises_cloturees_pct','roi_mises_global_pct',
          'pnl_cloture_usdc','cout_cloture_usdc','pnl_positions_global_usdc',
          'cout_positions_global_usdc','evenements_clotures','positions_ouvertes',
          'historique_cloture_complet','positions_ouvertes_completes',
          'couts_manquants_clotures','couts_manquants_ouvertes']
    st.dataframe(df[view],use_container_width=True,hide_index=True,column_config={
        'roi_mises_cloturees_pct':'ROI mises clôturées (%)',
        'roi_mises_global_pct':'ROI positions global (%)',
        'pnl_cloture_usdc':'PnL clôturé (USDC)',
        'cout_cloture_usdc':'Coûts cumulés clôturés (USDC)',
        'pnl_positions_global_usdc':'PnL toutes positions (USDC)',
        'cout_positions_global_usdc':'Coûts cumulés totaux (USDC)',
        'evenements_clotures':'Événements distincts clôturés',
        'positions_ouvertes':'Positions ouvertes',
        'historique_cloture_complet':'Clôturées complètes',
        'positions_ouvertes_completes':'Ouvertes complètes',
        'couts_manquants_clotures':'Coûts clos manquants',
        'couts_manquants_ouvertes':'Coûts ouverts manquants'})
    st.download_button('Exporter les ROI en CSV',csv_export(df),file_name='roi_wallets_v182.csv',mime='text/csv')
    st.caption('ROI global : somme des PnL observés sur positions clôturées et ouvertes / somme de leurs coûts, uniquement si les deux historiques sont complets. Les transferts et positions combinatoires peuvent exiger une réconciliation supplémentaire. Aucun ROI n’est une garantie de gains futurs.')
