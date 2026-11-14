"""Historical research dashboard, using only local SQLite snapshots.
No secrets, no order placement, no silent network calls when browsing.
"""
from __future__ import annotations
from collections import Counter
from datetime import datetime,timezone
from pathlib import Path
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import uuid
import pandas as pd
import plotly.express as px
import streamlit as st
from historical_intelligence_ui import explorer as insight_explorer, advanced_wallet as insight_wallet, discovered_wallets as insight_candidates, global_roi_dashboard as insight_roi
from historical_db import (open_db,coverage,wallet_summaries,sector_rows,event_rows,daily_points,periods,
                            import_runs,classify,n,upsert_market,WALLET,trade_sectors)


def table(rows:list[dict]) -> pd.DataFrame:
    return pd.DataFrame(rows)


def fmt(v,digits=0):
    try:
        f=float(v)
        return ('{:,.%df}'%digits).format(f).replace(',',' ')
    except (ValueError,TypeError):return '—'


def short(w:str)->str:
    return w[:8]+'…'+w[-5:] if len(w)>20 else w


def money(v)->str:return fmt(v,2)+' USDC'


def label_wallet(w,names):
    name=str(names.get(w) or '').strip()
    return (name+' · ' if name else '')+short(w)


def page_title(text,sub):
    st.title(text)
    st.caption(sub)


def describe_source():
    st.caption('Champ : wallets présents dans la base locale, non toute la population Polymarket. '
               'PnL par secteur = positions clôturées observées ; PnL par jour = variation du PnL économique cumulé '
               '(peut comprendre des valorisations latentes et des récompenses). Toutes les dates sont en UTC.')


def data_root(root:Path) -> Path:
    return (Path(os.environ['POLYMARKET_DATA_DIR']) if os.environ.get('POLYMARKET_DATA_DIR')
            else Path(os.environ['LOCALAPPDATA'])/'PolymarketIntelligence' if sys.platform=='win32' and os.environ.get('LOCALAPPDATA')
            else root/'historical')

def get_db(root:Path):
    # Windows persistence across V1.7, V1.8, etc. not inside a version-specific ZIP directory.
    base=(Path(os.environ['POLYMARKET_DATA_DIR']) if os.environ.get('POLYMARKET_DATA_DIR')
          else Path(os.environ['LOCALAPPDATA'])/'PolymarketIntelligence' if sys.platform=='win32' and os.environ.get('LOCALAPPDATA')
          else root/'historical')
    path=base/'historique.sqlite'
    return open_db(path),path


def job_status(root:Path):
    path=data_root(root)/'historical'/'refresh_status.json'
    if not path.is_file():return {}
    try:return json.loads(path.read_text(encoding='utf-8'))
    except Exception:return {}


def run_worker(root:Path, dbpath:Path, wallets:list[str], pages:int, gamma:int, folder:str|None=None, discover:int=0, board_pages:int=1, controls:int=1):
    status=data_root(root)/'historical'/'refresh_status.json'
    prev=job_status(root)
    if prev.get('state')=='running':raise RuntimeError('Une actualisation est déjà en cours.')
    cmd=[sys.executable,str(root/'historical_worker.py'),'--db',str(dbpath),'--status',str(status),
        '--pages',str(pages),'--gamma-limit',str(gamma)]
    if wallets:cmd+=['--wallets',*wallets]
    if folder:cmd+=['--import-folder',folder]
    if discover:cmd+=['--discover',str(discover),'--board-pages',str(board_pages),'--control-pages',str(controls)]
    if not wallets and not folder and gamma==0 and discover==0:raise ValueError('Choisis une action à réaliser.')
    # The application may be freshly extracted; /historical is not present yet.
    # Create it *before* writing refresh_status.json, not just before opening the log.
    status.parent.mkdir(parents=True, exist_ok=True)
    # Ensure stale status does not masquerade startup.
    status.write_text(json.dumps({'state':'running','phase':'Initialisation','completed':0,'total':len(wallets)},ensure_ascii=False),encoding='utf-8')
    logfile=data_root(root)/'historical'/'refresh_worker.log'
    with logfile.open('a',encoding='utf-8') as log:
        subprocess.Popen(cmd,cwd=str(root),stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,
                         creationflags=(subprocess.CREATE_NO_WINDOW if sys.platform=='win32' else 0))


def dashboard_global(db):
    page_title('Intelligence historique', 'Explore les performances passées des traders à partir des wallets sauvegardés.')
    c=coverage(db)
    k=st.columns(4)
    k[0].metric('Wallets dans la base',c['wallets'])
    k[1].metric('Transactions uniques',fmt(c['trades']))
    k[2].metric('Positions clôturées',fmt(c['closed_positions']))
    k[3].metric('Points de PnL',fmt(c['pnl_points']))
    if not c['wallets']:
        st.info('Aucun historique importé. Ouvre « Historique — Actualisation » pour importer tes anciennes collectes V1.2 à V1.6, ou ajouter des wallets.')
        return
    st.warning('Le classement porte uniquement sur les wallets que nous avons collectés. Il ne représente pas tous les traders Polymarket.')
    rows=wallet_summaries(db)
    names={r['wallet']:r['name'] for r in rows}
    df=table(rows)
    df['Wallet']=df['wallet'].map(lambda w:label_wallet(w,names))
    st.markdown('### Top historiques — PnL réalisé cumulé')
    st.caption('Source : série PnL officielle lorsqu’elle existe. Le total des positions clôturées est montré séparément pour contrôle comptable.')
    cols=['Wallet','realized_pnl','closed_pnl','economic_pnl','closed_events','trades_imported','volume_usdc','closed_exhausted']
    leaders=df.sort_values('realized_pnl',ascending=False,na_position='last')
    st.dataframe(leaders[[v for v in cols if v in leaders]],use_container_width=True,hide_index=True,
        column_config={'realized_pnl':st.column_config.NumberColumn('PnL réalisé officiel (USDC)',format='%.2f'),
        'closed_pnl':st.column_config.NumberColumn('Somme positions closes (USDC)',format='%.2f'),
        'closed_events':'Événements clos','trades_imported':'Trades observés',
        'volume_usdc':'Volume officiel (USDC)',
        'closed_exhausted':'Historique closes complet'})
    st.markdown('### Classement par période')
    period=st.radio('Période (PnL économique)',options=[7,30,90],index=1,horizontal=True,format_func=lambda x:f'{x} jours',key='historical_period')
    r=periods(db,int(period or 30))
    if r:
        recent=table(r).sort_values('variation_economique_usdc',ascending=False)
        recent['Trader']=recent.wallet.map(lambda w:label_wallet(w,names))
        st.caption('Variation du PnL économique cumulatif : elle peut inclure des variations latentes, pas seulement du profit encaissé. Le jour de référence est identique pour tous les wallets affichés.')
        st.dataframe(recent[['Trader','variation_economique_usdc','debut_utc','fin_utc']],hide_index=True,use_container_width=True,
                     column_config={'variation_economique_usdc':'Variation économique USDC','debut_utc':'Début UTC','fin_utc':'Fin UTC'})
    else:st.info('Aucune paire de points PnL suffisamment précise pour cette période. Relance une récupération des historiques.')
    st.markdown('### Spécialisations visibles')
    sec=sector_rows(db)
    if sec:
        grouped=table(sec).groupby('secteur',as_index=False).agg(
            pnl_usdc=('pnl_usdc','sum'),positions=('positions','sum'),evenements=('evenements_distincts','sum'))
        st.plotly_chart(px.bar(grouped.sort_values('pnl_usdc'),x='pnl_usdc',y='secteur',orientation='h',
                     labels={'pnl_usdc':'PnL réalisé sur positions closes (USDC)','secteur':'Secteur'}),use_container_width=True)
        st.caption('Les secteurs peuvent inclure des classifications provisoires. Les événements non résolus ne sont pas inclus dans ce graphique.')
    describe_source()


def dashboard_sector(db):
    page_title('Secteurs & top performers', 'Quels wallets sont spécialisés en sport, politique, crypto ou économie ?')
    raw=sector_rows(db)
    if not raw:st.info('Aucune position clôturée exploitable. Importe un historique depuis « Actualisation ».');return
    df=table(raw)
    names={x['wallet']:x['name'] for x in wallet_summaries(db)}
    available=sorted(df.secteur.unique().tolist())
    selected=st.selectbox('Secteur', ['Tous les secteurs']+available)
    minimum=st.slider('Événements clôturés minimum',1,100,1)
    if selected!='Tous les secteurs':df=df[df.secteur==selected]
    df=df[df.evenements_distincts>=minimum].copy()
    st.caption('Classement : PnL réalisé par wallet et secteur sur les positions clôturées disponibles. L’échantillon n’est pas représentatif de l’ensemble des traders.')
    if df.empty:st.info('Aucun wallet ne satisfait ces filtres.');return
    df['Trader']=df.wallet.map(lambda w:label_wallet(w,names))
    df['Part du secteur estimée (%)']=df.part_classement_estime_pct
    st.dataframe(df.sort_values('pnl_usdc',ascending=False)[['Trader','secteur','pnl_usdc','evenements_distincts','positions',
       'taux_positions_gagnantes_pct','Part du secteur estimée (%)']],use_container_width=True,hide_index=True,
       column_config={'pnl_usdc':'PnL réalisé (USDC)','secteur':'Secteur','evenements_distincts':'Événements clôturés',
                      'positions':'Positions clôturées','taux_positions_gagnantes_pct':'Positions gagnantes (%)'})
    st.markdown('### Activité historique par secteur')
    activity=table(trade_sectors(db))
    if selected!='Tous les secteurs' and not activity.empty: activity=activity[activity.secteur==selected]
    if not activity.empty:
        activity['Trader']=activity.wallet.map(lambda w:label_wallet(w,names))
        st.dataframe(activity.sort_values('notionnel_observe_usdc',ascending=False).head(50)[
            ['Trader','secteur','trades','evenements_distincts','notionnel_observe_usdc','part_provisoire_pct']],
            hide_index=True,use_container_width=True)
    st.caption('Ce tableau mesure les spécialités en nombre de transactions et notionnel des fills observés, et non un rendement financier.')
    st.markdown('### Plus gros profits et pertes par événement')
    ev=table(event_rows(db))
    if selected!='Tous les secteurs':ev=ev[ev.secteur==selected]
    if not ev.empty:
        ev['Trader']=ev.wallet.map(lambda w:label_wallet(w,names))
        a,b=st.columns(2)
        with a:
            st.markdown('**Top événements gagnants**')
            st.dataframe(ev.nlargest(15,'pnl_usdc')[['Trader','titre','secteur','pnl_usdc','source_secteur']],
                         use_container_width=True,hide_index=True)
        with b:
            st.markdown('**Top événements perdants**')
            st.dataframe(ev.nsmallest(15,'pnl_usdc')[['Trader','titre','secteur','pnl_usdc','source_secteur']],
                         use_container_width=True,hide_index=True)
    st.caption('La classification officielle dépend des tags Gamma, récupérables dans « Actualisation ». À défaut, le secteur indiqué peut être déduit du titre et doit être confirmé.')
    describe_source()


def dashboard_wallet(db):
    page_title('Profil historique des traders','Décompose les performances et le comportement d’un wallet, secteur par secteur.')
    rows=wallet_summaries(db)
    if not rows:st.info('Importe d’abord un historique.');return
    names={r['wallet']:r['name'] for r in rows}
    wallets=[r['wallet'] for r in rows]
    selected=st.selectbox('Choisir un wallet',wallets,format_func=lambda w:label_wallet(w,names))
    row=next(r for r in rows if r['wallet']==selected)
    k=st.columns(4)
    k[0].metric('PnL réalisé officiel',money(row['realized_pnl']))
    k[1].metric('PnL des positions clôturées',money(row['closed_pnl']))
    k[2].metric('Marchés/événements clôturés',int(row['closed_events'] or 0))
    k[3].metric('Volume officiel',money(row['volume_usdc']))
    if not row['trade_exhausted'] or not row['closed_exhausted']:
        st.warning('Historique non exhaustif ou non confirmé. Ne conclus pas à un taux de réussite ou ROI global fiable.')
    dailies=table(daily_points(db,selected))
    if not dailies.empty:
        dailies['jour_utc']=pd.to_datetime(dailies['jour_utc'])
        long=dailies.melt('jour_utc',value_vars=['pnl_economique_cumul','pnl_realise_cumul'],
             value_name='USDC',var_name='Indicateur').dropna()
        if not long.empty:
            st.plotly_chart(px.line(long,x='jour_utc',y='USDC',color='Indicateur',
                     title='Historique de PnL cumulatif (selon la série API)'),use_container_width=True)
    s=table(sector_rows(db,selected))
    if not s.empty:
        st.markdown('### Secteurs de spécialisation')
        st.dataframe(s.sort_values('pnl_usdc',ascending=False)[['secteur','pnl_usdc','evenements_distincts','positions',
                       'taux_positions_gagnantes_pct','part_classement_estime_pct']],hide_index=True,use_container_width=True)
        st.plotly_chart(px.bar(s,x='secteur',y='pnl_usdc',labels={'secteur':'Secteur','pnl_usdc':'PnL réalisé USDC'}),use_container_width=True)
    trade_focus=table(trade_sectors(db,selected))
    if not trade_focus.empty:
        st.markdown('### Où ce trader est-il le plus actif ?')
        st.dataframe(trade_focus.sort_values('notionnel_observe_usdc',ascending=False)[
           ['secteur','trades','evenements_distincts','notionnel_observe_usdc','part_provisoire_pct']],
           hide_index=True,use_container_width=True)
    ev=table(event_rows(db,selected))
    if not ev.empty:
        st.markdown('### Plus gros gains et pertes par événement')
        c1,c2=st.columns(2)
        with c1:st.dataframe(ev.nlargest(10,'pnl_usdc')[['titre','secteur','pnl_usdc']],hide_index=True,use_container_width=True)
        with c2:st.dataframe(ev.nsmallest(10,'pnl_usdc')[['titre','secteur','pnl_usdc']],hide_index=True,use_container_width=True)
    rows_tr=db.execute('SELECT timestamp,side,title,event_slug,price,size FROM trades WHERE wallet=? ORDER BY timestamp DESC LIMIT 10000',(selected,)).fetchall()
    if rows_tr:
        t=table([dict(r) for r in rows_tr]);t['datetime_utc']=pd.to_datetime(t.timestamp,unit='s',utc=True,errors='coerce')
        t['jour_semaine']=t.datetime_utc.dt.day_name()
        t['heure_utc']=t.datetime_utc.dt.hour
        st.markdown('### Activité du trader')
        a,b=st.columns(2)
        with a:
            wd=t.jour_semaine.value_counts().rename_axis('Jour').reset_index(name='Trades')
            st.plotly_chart(px.bar(wd,x='Jour',y='Trades',title='Jours de la semaine (nombre de trades, UTC)'),use_container_width=True)
        with b:
            ht=t.heure_utc.value_counts().rename_axis('Heure UTC').reset_index(name='Trades').sort_values('Heure UTC')
            st.plotly_chart(px.bar(ht,x='Heure UTC',y='Trades',title='Heures d’activité (UTC)'),use_container_width=True)
        st.markdown('### Dernières transactions observées')
        st.dataframe(t[['datetime_utc','side','title','price','size','event_slug']].head(100),hide_index=True,use_container_width=True)
    st.caption('Les durées de détention et les performances journalières par secteur nécessitent une comptabilité de positions datée, distincte des snapshots de positions clôturées.')
    describe_source()


def dashboard_days(db):
    page_title('Top performers par jour','Compare les variations de PnL économique et l’activité des wallets, jour par jour.')
    data=daily_points(db)
    valid=[r for r in data if r.get('variation_economique_usdc') is not None]
    if not valid:
        st.info('Pas encore de dates successives avec points de PnL économique disponibles. Il faut une série assez précise pour calculer une vraie variation journalière.');return
    names={r['wallet']:r['name'] for r in wallet_summaries(db)}
    d=table(valid)
    dates=sorted(d.jour_utc.unique().tolist(),reverse=True)
    selected=st.selectbox('Jour (UTC)',dates)
    selected_df=d[d.jour_utc==selected].sort_values('variation_economique_usdc',ascending=False).copy()
    selected_df['Trader']=selected_df.wallet.map(lambda w:label_wallet(w,names))
    st.caption('Les journées manquantes sont exclues, sans répartir arbitrairement les gains sur plusieurs dates.')
    st.dataframe(selected_df[['Trader','variation_economique_usdc','pnl_economique_cumul','fidelite_source']],
                 hide_index=True,use_container_width=True,
                 column_config={'variation_economique_usdc':'Variation du jour (USDC)','pnl_economique_cumul':'PnL économique cumulé (USDC)',
                                'fidelite_source':'Résolution API'})
    st.plotly_chart(px.bar(selected_df.head(20),x='Trader',y='variation_economique_usdc',
            title='Meilleurs résultats économiques du jour parmi les wallets étudiés'),use_container_width=True)
    st.markdown('### Historique quotidien comparé')
    choices=st.multiselect('Comparer plusieurs traders',sorted(d.wallet.unique()),default=list(selected_df.wallet.head(3)),
                           max_selections=8,format_func=lambda w:label_wallet(w,names))
    if choices:
        sub=d[d.wallet.isin(choices)].copy();sub['Trader']=sub.wallet.map(lambda w:label_wallet(w,names))
        st.plotly_chart(px.line(sub,x='jour_utc',y='variation_economique_usdc',color='Trader',markers=True),use_container_width=True)
    describe_source()


def dashboard_update(db,dbpath,root):
    page_title('Actualiser la base historique','Importer le passé une fois, puis ajouter les nouvelles transactions sans tout recommencer.')
    c=coverage(db)
    x=st.columns(4)
    x[0].metric('Wallets',c['wallets']);x[1].metric('Trades uniques',c['trades'])
    x[2].metric('Historiques de trades épuisés',f"{c['complete_trade_histories']}/{c['wallets']}")
    x[3].metric('Événements Gamma classés',c['gamma_events'])
    status=job_status(root)
    if status:
        state=status.get('state','inconnu')
        if state=='running':
            st.info('Récupération en cours — '+str(status.get('phase') or ''))
            total=max(1,int(status.get('total') or 1));st.progress(min(1,float(status.get('completed') or 0)/total))
            col1,col2=st.columns(2)
            if col1.button('↻ Actualiser l’affichage'):st.rerun()
            if col2.button('⏹ Interrompre proprement'): (data_root(root)/'historical'/'refresh_status.stop').write_text('stop',encoding='utf-8')
        elif state=='completed':st.success('Dernière actualisation terminée. Les profils peuvent être consultés.')
        elif state=='failed':st.error('La dernière actualisation a échoué. Vérifie le journal ci-dessous.')
        else:st.warning('Dernière actualisation : '+state)
        with st.expander('Journal de collecte'):
            for m in status.get('messages',[]):st.text(m)
    st.markdown('### 1. Importer les collectes déjà réalisées')
    st.caption('Sélectionne l’ancien dossier runs (V1.2–V1.6). Les fichiers sources sont conservés et les transactions déjà connues ne sont pas dupliquées.')
    old=st.text_input('Chemin du dossier runs existant',placeholder=r'C:\Users\...\polymarket_dashboard_v16\runs',key='history_import_path')
    if st.button('Importer ces historiques',disabled=(status.get('state')=='running')):
        try:
            if not old.strip():raise ValueError('Indique un dossier runs.')
            run_worker(root,dbpath,[],30,60,folder=old.strip().strip('"'))
            st.success('Import lancé en arrière-plan. La progression apparaîtra ci-dessus ; les anciens fichiers sont conservés.')
        except Exception as e:st.error(str(e))
    st.markdown('### 2. Découvrir automatiquement les meilleurs profils')
    st.caption('Interroge les classements publics globaux et par secteur. Les wallets découverts sont enregistrés durablement, puis un échantillon est collecté en profondeur.')
    a,b,c=st.columns(3)
    with a:auto_wallets=st.selectbox('Wallets à récupérer', [5,10,20,50,100],index=2)
    with b:auto_pages=st.selectbox('Pages par classement', [1,2,3],index=0)
    with c:active_controls=st.selectbox('Pages du flux actif (groupe de comparaison)', [0,1,2],index=1)
    if st.button('Découvrir et récupérer les historiques',type='primary',disabled=status.get('state')=='running'):
        try:
            run_worker(root,dbpath,[],35,100,discover=auto_wallets,board_pages=auto_pages,controls=active_controls)
            st.success('Découverte et récupération lancées. Consulte la progression en haut de cette page.')
        except Exception as ex:st.error(str(ex))
    st.markdown('### 3. Actualiser les wallets déjà connus')
    st.caption('La première récupération parcourt le passé ; les mises à jour suivantes recherchent les nouveaux trades. Les PnL et positions sont rafraîchis.')
    current=[r['wallet'] for r in wallet_summaries(db)]
    chosen=st.multiselect('Wallets déjà enregistrés',current,default=current[:min(10,len(current))],
                          format_func=short,key='historical_selected_wallets')
    extra=st.text_area('Ajouter des wallets (facultatif, un par ligne)',height=78,placeholder='0x...')
    page_budget=st.select_slider('Profondeur maximum de l’historique par wallet',options=[5,20,50,100,250],value=50)
    gamma_limit=st.slider('Nouveaux événements à classifier via Gamma',0,300,60,10)
    if st.button('Lancer l’actualisation historique',type='primary',disabled=(status.get('state')=='running')):
        new=[s.strip().lower() for s in extra.replace(',','\n').splitlines() if s.strip()]
        wallets=list(dict.fromkeys(chosen+new))
        invalid=[w for w in wallets if not WALLET.fullmatch(w)]
        if invalid:st.error('Adresse invalide : '+invalid[0][:80])
        else:
            try:
                run_worker(root,dbpath,wallets,page_budget,gamma_limit)
                st.success('Collecte lancée en arrière-plan. Clique sur « Actualiser l’affichage » pour voir sa progression.')
            except Exception as ex:st.error(str(ex))
    st.markdown('### 4. Correction des secteurs')
    st.caption('Si Gamma ne permet pas de classer un événement avec certitude, tu peux définir son secteur manuellement.')
    rows=db.execute('''SELECT event_key,title FROM (SELECT event_key,title FROM positions UNION SELECT event_key,title FROM trades)
        WHERE event_key IS NOT NULL AND event_key!='' LIMIT 2000''').fetchall()
    if rows:
        keys={x['event_key']:x['title'] for x in rows}
        key=st.selectbox('Événement à classer',sorted(keys),format_func=lambda k:(keys[k] or k)[:95])
        existing=classify(db,key,keys[key])
        st.caption(f'Classification actuelle : {existing[0]} · source : {existing[1]}')
        newcat=st.selectbox('Secteur corrigé',['Sport','Politique','Crypto','Économie','Culture / Tech','Autre','Non classé'])
        if st.button('Enregistrer cette classification'):
            upsert_market(db,key,[],keys[key],override=newcat)
            st.success('Secteur corrigé et conservé dans la base locale.')
    st.markdown('### Sauvegarde de la base')
    st.caption('Sous Windows, la base est enregistrée dans %LOCALAPPDATA%\\PolymarketIntelligence\\historique.sqlite et sera réutilisée automatiquement par les futures versions. Sur les autres systèmes, elle reste dans le dossier historical de l’application.')
    if dbpath.is_file():
        import tempfile
        with tempfile.TemporaryDirectory() as temp:
            save=Path(temp)/'historique_export.sqlite'
            replica=sqlite3.connect(save)
            try: db.backup(replica)
            finally: replica.close()
            st.download_button('Exporter la base historique SQLite (sauvegarde cohérente)',save.read_bytes(),
                file_name='historique_polymarket.sqlite',mime='application/octet-stream')
    describe_source()


def render(page:str,root:Path):
    db,dbpath=get_db(root)
    try:
        if page=='Historique — ROI global':insight_roi(db)
        elif page=='Historique — Vue globale':dashboard_global(db)
        elif page=='Historique — Secteurs':dashboard_sector(db)
        elif page=='Historique — Profils':dashboard_wallet(db)
        elif page=='Historique — Journées':dashboard_days(db)
        elif page=='Historique — Actualisation':dashboard_update(db,dbpath,root)
        elif page=='Historique — Classement avancé':insight_explorer(db)
        elif page=='Historique — Fiche avancée':insight_wallet(db)
        elif page=='Historique — Wallets découverts':insight_candidates(db)
    finally:db.close()
