"""Polymarket Intelligence — concise 3-screen research console.

Read-only public data; no execution. Preserve all historical SQLite and existing runs.
"""
from __future__ import annotations
from datetime import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

import pandas as pd
import plotly.express as px
import streamlit as st

from historical_db import open_db, daily_points, periods
from historical_intelligence import event_ledger
from historical_discovery import candidates
from quality_metrics import wallet_metrics, sector_metrics, label, MIN_EVIDENCE_EVENTS
from update_ui import render_update_page

ROOT=Path(__file__).resolve().parent
DATA_ROOT=Path(os.environ.get('POLYMARKET_DATA_DIR') or
               (Path(os.environ.get('LOCALAPPDATA',str(ROOT))) / 'PolymarketIntelligence'))
HISTORY=DATA_ROOT/'historical'
HISTORY.mkdir(parents=True,exist_ok=True)
DB=HISTORY/'historique.sqlite'
STATUS=HISTORY/'refresh_status.json'
STOP=STATUS.with_suffix('.stop')

st.set_page_config(page_title='Polymarket Intelligence',page_icon='📊',layout='wide',initial_sidebar_state='collapsed')
st.markdown('''<style>
.block-container{max-width:1320px;padding-top:1.4rem}
[data-testid="stMetric"] {border:1px solid rgba(128,140,156,.2);padding:12px 16px;border-radius:12px}
[data-testid="stSidebar"]{border-right:none}
[data-testid="stTabs"] [data-baseweb="tab-list"]{gap:2rem}
[data-testid="stTabs"] [data-baseweb="tab"]{font-size:1rem;font-weight:600}
</style>''',unsafe_allow_html=True)


def fmt(value, suffix='', digits=1):
    try:
        if value is None or pd.isna(value):return '—'
        return f'{float(value):,.{digits}f}'.replace(',',' ') + suffix
    except (ValueError,TypeError):return '—'


def load_status():
    try:return json.loads(STATUS.read_text(encoding='utf-8'))
    except (FileNotFoundError,ValueError,OSError):return {}


@st.cache_data(ttl=35,show_spinner=False)
def load_summary(db_path:str):
    conn=open_db(db_path)
    try:
        wallets=wallet_metrics(conn)
        sectors=sector_metrics(conn,wallets)
        recent=periods(conn,30)
        return wallets,sectors,recent
    finally:conn.close()


def run_worker(*,discover=0,wallets=None,mode='rapide',workers=4,gamma_limit=0,import_folder=None):
    state=load_status()
    if state.get('state')=='running':raise RuntimeError('Une collecte fonctionne déjà.')
    STOP.unlink(missing_ok=True)
    cmd=[sys.executable,str(ROOT/'historical_worker.py'),
         '--db',str(DB),'--status',str(STATUS),'--mode',mode,
         '--workers',str(workers),'--pages',str(100 if mode=='approfondi' else 4),
         '--gamma-limit',str(gamma_limit)]
    if discover:cmd+=['--discover',str(discover),'--board-pages','1','--control-pages','1']
    if wallets:cmd+=['--wallets',*wallets]
    if import_folder:cmd+=['--import-folder',str(import_folder)]
    logfile=HISTORY/'collecte.log'
    flags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
    with logfile.open('a',encoding='utf-8') as log:
        subprocess.Popen(cmd,cwd=str(ROOT),stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,
                         creationflags=flags)


def status_panel():
    state=load_status()
    status=state.get('state')
    if not status:return
    counts=f"{state.get('completed',0)} / {state.get('total',0)} wallets"
    if status=='running':
        st.info('Collecte en cours · '+counts+' · '+str(state.get('phase','')))
        total=max(1,int(state.get('total',0) or 1))
        st.progress(min(1.,int(state.get('completed',0) or 0)/total))
        a,b=st.columns([1,5])
        if a.button('Arrêter la collecte'):
            STOP.write_text('stop',encoding='utf-8')
            st.warning('Arrêt demandé : les requêtes en cours termineront normalement.')
        if b.button('Actualiser la progression'):st.rerun()
    elif status=='completed':st.success('Dernière collecte terminée · '+counts)
    elif status=='partial':st.warning('Collecte partielle · '+counts+' · certains wallets ont échoué')
    elif status=='failed':st.error('Collecte en erreur : consulte les détails ci-dessous')
    elif status=='canceled':st.info('Collecte interrompue')
    if status!='running':
        if st.button('Recharger les chiffres',key='reload_metrics'):
            load_summary.clear();st.rerun()
    if state.get('messages'):
        with st.expander('Détails techniques',expanded=status=='failed'):
            st.code('\n'.join(state['messages'][-18:]),language='text')


def data_frame(rows):
    return pd.DataFrame(rows) if rows else pd.DataFrame()


def ranking_screen(wallets,sectors,recent):
    st.subheader('Les traders les plus performants')
    st.caption('Les ROI ne sont affichés comme validés que si les positions clôturées et leurs coûts sont exhaustifs. Aucun taux de réussite basé sur quelques positions.')
    if not wallets:
        st.info('Aucun historique collecté. Va dans « Collecte » pour rechercher automatiquement les premiers traders.')
        return
    overall=data_frame(wallets)
    a,b,c=st.columns(3)
    a.metric('Wallets analysés',len(overall))
    b.metric('ROI clôturé vérifiable',f"{int(overall.roi_closed_pct.notna().sum())}/{len(overall)}")
    c.metric('Au moins 30 événements',int((overall.events>=MIN_EVIDENCE_EVENTS).sum()))
    left,middle,right=st.columns([1.25,1.1,1])
    modes=['ROI sur mises clôturées','ROI indicatif (échantillon)','PnL économique observé','Efficacité PnL / volume','Performance 30 jours']
    verified_count=int(overall.roi_closed_pct.notna().sum())
    metric=left.selectbox('Classer par',modes,index=0 if verified_count else 2)
    min_events=middle.select_slider('Événements minimum',[0,5,10,20,30,50,100,200],value=30)
    sector_names=sorted({s['sector'] for s in sectors})
    chosen_sector=right.selectbox('Secteur',['Tous']+sector_names)
    df=overall[overall.events>=min_events].copy()
    if chosen_sector!='Tous':
        s=data_frame([s for s in sectors if s['sector']==chosen_sector])
        if s.empty:df=df.iloc[0:0]
        else:
            df=df.merge(s[['wallet','roi_pct','pnl_usdc','events','closed_complete']],on='wallet',suffixes=('','_sector'))
            df=df.rename(columns={'events_sector':'sector_events'})
    recent_by_wallet={r['wallet']:r.get('variation_economique_usdc') for r in recent}
    if 'recent_30' not in df:df['recent_30']=df.wallet.map(recent_by_wallet)
    if chosen_sector!='Tous':
        key={'ROI sur mises clôturées':'roi_pct','PnL économique observé':'pnl_usdc',
             'ROI indicatif (échantillon)':'partial_roi_pct',
             'Efficacité PnL / volume':'efficiency_pct','Performance 30 jours':'recent_30'}[metric]
    else:
        key={'ROI sur mises clôturées':'roi_closed_pct','PnL économique observé':'economic_pnl_usdc',
             'ROI indicatif (échantillon)':'partial_roi_pct',
             'Efficacité PnL / volume':'efficiency_pct','Performance 30 jours':'recent_30'}[metric]
    # Never pretend a partially computed ROI is a validated global return.
    if metric=='ROI indicatif (échantillon)' and chosen_sector!='Tous':
        st.warning('Le ROI indicatif par secteur n’est pas disponible : la couverture du secteur n’est pas suffisante pour ce ratio. Sélectionne « Tous » ou audite les wallets.')
        return
    if metric=='ROI indicatif (échantillon)':
        st.warning('Indicateur provisoire sur les positions récupérées dont le coût est connu. Classement non validé : biais possible, y compris si toutes les positions restantes sont perdantes.')
        df=df[df[key].notna()]
    if metric=='ROI sur mises clôturées':
        df=df[df[key].notna()]
        if chosen_sector!='Tous':df=df[df.sector_events>=min_events]
    if df.empty:
        st.warning('Aucun résultat avec un ROI suffisamment documenté pour ces filtres. Lance « Auditer » sur les wallets intéressants ou réduis le nombre minimum d’événements.')
        return
    df=df.sort_values(key,ascending=False,na_position='last').head(150)
    df['ROI confirmé (%)']=df['roi_pct'] if chosen_sector!='Tous' else df['roi_closed_pct']
    if metric=='ROI indicatif (échantillon)':df['ROI indicatif (%)']=df['partial_roi_pct']
    df['PnL (USDC)']=df['pnl_usdc'] if chosen_sector!='Tous' else df['economic_pnl_usdc']
    df['Événements']=df['sector_events'] if chosen_sector!='Tous' else df['events']
    displayed=['trader','ROI confirmé (%)']
    if metric=='ROI indicatif (échantillon)':displayed+=['ROI indicatif (%)','cost_events']
    displayed+=['PnL (USDC)','Événements','volume_usdc','data_status']
    displayed=[x for x in displayed if x in df.columns]
    st.dataframe(df[displayed].rename(columns={'trader':'Trader','volume_usdc':'Volume USDC','data_status':'Qualité','cost_events':'Événements avec coût connu'}),
        use_container_width=True,hide_index=True,column_config={
            'ROI confirmé (%)':st.column_config.NumberColumn('ROI mises clôturées',format='%.2f %%'),
            'PnL (USDC)':st.column_config.NumberColumn('PnL (USDC)',format='%.2f'),
            'Volume USDC':st.column_config.NumberColumn('Volume (USDC)',format='%.0f'),
            'ROI indicatif (%)':st.column_config.NumberColumn('ROI provisoire',format='%.2f %%')})
    st.caption('« Efficacité PnL / volume » est un ratio sur le turnover, pas un ROI. Les gains clôturés ne tiennent pas nécessairement compte des pertes encore ouvertes. La performance 30 jours mesure la variation du PnL économique sur la fenêtre observée.')
    st.download_button('Exporter ce classement',df.to_csv(index=False).encode('utf-8-sig'),
                       file_name='classement_polymarket.csv',mime='text/csv')


def profile_screen(wallets,sectors):
    st.subheader('Comprendre un trader')
    if not wallets:st.info('Aucun wallet analysé.');return
    opts={w['wallet']:w for w in wallets}
    pick=st.selectbox('Trader à analyser',list(opts),format_func=lambda w:opts[w]['trader']+' · '+w[:9]+'…')
    r=opts[pick]
    st.caption('Dernière collecte : '+str(r['updated'] or 'inconnue'))
    if not r['closed_complete']:
        st.warning('Historique clôturé incomplet : les résultats sont partiels et ne peuvent pas servir à classer ce trader par ROI global.')
    if r['reasons']:
        with st.expander('Pourquoi certains indicateurs ne sont-ils pas calculables ?',expanded=r['roi_closed_pct'] is None):
            for reason in r['reasons']:st.write('• '+reason)
    c1,c2,c3,c4=st.columns(4)
    c1.metric('ROI positions closes',fmt(r['roi_closed_pct'],' %',2))
    c2.metric('ROI ouvertes incluses',fmt(r['roi_global_pct'],' %',2))
    c3.metric('PnL économique observé',fmt(r['economic_pnl_usdc'],' USDC',0))
    c4.metric('Événements clôturés',r['events'])
    if r['roi_closed_pct'] is None and r['partial_roi_pct'] is not None:
        st.info('Indication uniquement : ROI des **positions dont le coût est connu** = '
                +fmt(r['partial_roi_pct'],' %',2)+f" sur {r['cost_events']}/{r['events']} événements. "
                'Ce chiffre est biaisable et volontairement exclu des classements.')
    st.caption('Le ROI affiché est le PnL des positions / coût cumulé des positions, pas le rendement du capital déposé. Un résultat exceptionnel peut provenir d’un échantillon réduit ou de pertes latentes non clôturées.')
    if r['closed_complete'] and r['events']>=MIN_EVIDENCE_EVENTS:
        st.caption(f"Événements clôturés : {r['winning_events']} gagnants, {r['losing_events']} perdants sur {r['events']} observés. Les positions ouvertes n'entrent pas dans ce décompte.")
    else:st.caption('Taux de réussite non affiché : il faut au moins 30 événements et un historique clôturé complet. Un « 100 % de positions positives » ne constitue pas une mesure fiable.')
    db=open_db(DB)
    try:
        df=data_frame(daily_points(db,pick))
        st.markdown('#### Évolution du PnL')
        if not df.empty and df.pnl_economique_cumul.notna().any():
            df['jour_utc']=pd.to_datetime(df.jour_utc)
            st.plotly_chart(px.line(df,x='jour_utc',y='pnl_economique_cumul',
                          labels={'jour_utc':'Jour UTC','pnl_economique_cumul':'PnL économique cumulatif (USDC)'}),
                          use_container_width=True)
        else:st.caption('Courbe indisponible : aucune série PnL suffisamment précise.')
        st.markdown('#### Spécialisation par secteur')
        subset=data_frame([s for s in sectors if s['wallet']==pick])
        if not subset.empty:
            st.dataframe(subset[['sector','events','pnl_usdc','roi_pct','cost_coverage_pct','source_proven_pct','confidence']].rename(columns={
                'sector':'Secteur','events':'Événements','pnl_usdc':'PnL clôturé USDC','roi_pct':'ROI mises (%)',
                'cost_coverage_pct':'Coûts connus (%)','source_proven_pct':'Catégorie vérifiée (%)','confidence':'Confiance'}),
                hide_index=True,use_container_width=True)
        else:st.caption('Aucune position clôturée classifiable par secteur.')
        st.markdown('#### Meilleurs et pires événements')
        ev=data_frame(event_ledger(db,pick))
        if not ev.empty:
            ev=ev[ev.event_identifier_valid]
            cols=['title','sector','pnl_usdc','basis_usdc','pnl_per_entry_cost_pct']
            left,right=st.columns(2)
            with left:
                st.caption('Plus gros gains')
                st.dataframe(ev.nlargest(8,'pnl_usdc')[cols],hide_index=True,use_container_width=True)
            with right:
                st.caption('Plus grosses pertes')
                st.dataframe(ev.nsmallest(8,'pnl_usdc')[cols],hide_index=True,use_container_width=True)
    finally:db.close()


def collect_screen(wallets):
    st.subheader('Collecter et actualiser')
    st.caption('Une base unique sur ton PC. Les mises à jour ajoutent les données sans effacer tes anciennes collectes.')
    status_panel()
    running=load_status().get('state')=='running'
    left,right=st.columns(2,gap='large')
    with left:
        st.markdown('#### 1. Trouver de nouveaux traders')
        count=st.select_slider('Nombre de wallets',[10,20,30,50,100,150],value=20)
        st.caption('Mode rapide : plusieurs wallets en parallèle, premières positions et historiques. Les comptes importants nécessiteront ensuite un audit exhaustif pour valider leur ROI.')
        if st.button('Découvrir '+str(count)+' wallets',type='primary',disabled=running,use_container_width=True):
            try:run_worker(discover=count,mode='rapide',workers=4)
            except Exception as ex:st.error(str(ex))
            else:st.success('Collecte lancée. Actualise la progression dans quelques instants.')
    with right:
        st.markdown('#### 2. Auditer les wallets intéressants')
        options={r['wallet']:r for r in wallets}
        default=[r['wallet'] for r in wallets if r['roi_closed_pct'] is None][:3]
        selected=st.multiselect('Wallets à examiner',list(options),default=default[:3],
            format_func=lambda w:options[w]['trader']+' · '+str(options[w]['events'])+' événements')
        st.caption('Audit approfondi : recherche toutes les pages disponibles, collecte plus lente mais indispensable pour calculer un ROI vérifiable.')
        if st.button('Auditer la sélection',disabled=running or not selected,use_container_width=True):
            try:run_worker(wallets=selected,mode='approfondi',workers=3,gamma_limit=30)
            except Exception as ex:st.error(str(ex))
            else:st.success('Audit lancé.')
    with st.expander('Options avancées : actualisation, ancien dossier, mises à jour'):
        custom=st.text_area('Adresses de wallets (une adresse 0x par ligne)',placeholder='0x…',height=80)
        if st.button('Actualiser ces wallets',disabled=running or not custom.strip()):
            import re
            values=list(dict.fromkeys(x.strip().lower() for x in custom.splitlines() if x.strip()))
            if any(not re.fullmatch(r'0x[0-9a-f]{40}',w) for w in values):st.error('Une ou plusieurs adresses sont invalides.')
            else:
                try:run_worker(wallets=values,mode='approfondi',workers=3)
                except Exception as ex:st.error(str(ex))
                else:st.success('Actualisation lancée.')
        st.divider()
        prior=st.text_input('Importer des anciennes collectes : chemin du dossier runs')
        if st.button('Importer ce dossier',disabled=running or not prior.strip()):
            try:run_worker(import_folder=str(Path(prior.strip().strip('"')).expanduser()),mode='rapide')
            except Exception as ex:st.error(str(ex))
            else:st.success('Import lancé.')
        st.divider()
        render_update_page()
    st.caption('Lecture seule · Les API peuvent ralentir ou limiter les requêtes. Aucune garantie sur la disponibilité d’un historique complet.')


st.markdown('### ◈ Polymarket Intelligence')
st.caption('Les vrais ROI, les meilleurs traders, leurs spécialités — sans données inventées · Version 2.0')
try:
    wallet_rows,sector_rows,recent_rows=load_summary(str(DB))
except Exception as ex:
    st.error('Erreur de lecture de la base historique : '+str(ex))
    wallet_rows=[];sector_rows=[];recent_rows=[]

section=st.radio('Navigation',['🏆 Classements','🔎 Profils','⟳ Collecte & mises à jour'],horizontal=True,label_visibility='collapsed')
if section=='🏆 Classements':ranking_screen(wallet_rows,sector_rows,recent_rows)
elif section=='🔎 Profils':profile_screen(wallet_rows,sector_rows)
else:collect_screen(wallet_rows)
