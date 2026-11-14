"""Streamlit settings for stable code-only updates and current-version diagnostics."""
from __future__ import annotations
from pathlib import Path
import os
import streamlit as st


def render_update_page():
    base=Path(os.environ.get('POLYMARKET_DATA_DIR') or (Path(os.environ.get('LOCALAPPDATA',str(Path.home()))) / 'PolymarketIntelligence'))
    st.title('Mises à jour de Polymarket Intelligence')
    st.caption('Les mises à jour remplacent le code, sans modifier la base historique ni les collectes.')
    if not (base/'update_manager.py').is_file():
        st.info('L’application doit être installée avec INSTALLER_UNE_FOIS.bat pour activer ce système de mise à jour.')
        return
    import sys
    if str(base) not in sys.path:sys.path.insert(0,str(base))
    from update_manager import read_settings,save_settings,local_version,fetch_manifest,download_release,version_tuple
    st.metric('Version installée',local_version(base))
    st.code(str(base),language='text')
    st.info('Tes historiques, sessions et paramètres restent dans ce dossier, indépendamment du code de l’application.')
    settings=read_settings(base)
    with st.form('updates_settings'):
        url=st.text_input('Adresse HTTPS du manifeste de mise à jour (GitHub Releases)',value=settings.get('manifest_url',''),
                          placeholder='https://raw.githubusercontent.com/OWNER/REPO/main/latest.json')
        auto=st.checkbox('Vérifier et installer les nouvelles versions au prochain lancement',value=bool(settings.get('auto_update',False)))
        save=st.form_submit_button('Enregistrer les paramètres')
        if save:
            from update_manager import https_url
            try:
                if url.strip():https_url(url.strip())
                if auto and not url.strip():raise ValueError('Indique une adresse HTTPS avant d’activer les mises à jour automatiques.')
                save_settings(base,{'manifest_url':url.strip(),'auto_update':auto})
                st.success('Paramètres enregistrés. Ils seront conservés entre les versions.')
            except Exception as ex:st.error(str(ex))
    if st.button('🔎 Rechercher une mise à jour'):
        if not url.strip():st.warning('Aucune source de mise à jour configurée. Une publication sur GitHub Releases sera nécessaire.')
        else:
            try:
                latest=fetch_manifest(url.strip())
                st.session_state['poly_release']=latest
                if version_tuple(latest['version'])>version_tuple(local_version(base)):
                    st.success('Nouvelle version disponible : '+latest['version'])
                else:st.success('L’application est à jour selon la source configurée.')
            except Exception as ex:st.error('Échec de vérification : '+str(ex))
    latest=st.session_state.get('poly_release')
    if latest and version_tuple(latest['version'])>version_tuple(local_version(base)):
        if st.button('⬇️ Télécharger la mise à jour pour le prochain lancement',type='primary'):
            try:
                download_release(latest,base)
                st.success('Téléchargement vérifié. Ferme puis relance Polymarket Intelligence pour appliquer la mise à jour.')
            except Exception as ex:st.error(str(ex))
    if (base/'updates'/'pending.zip').is_file():
        st.info('Une mise à jour est prête. Elle sera appliquée automatiquement au prochain lancement.')
    st.caption('Sans adresse de publication configurée, tu peux aussi installer un ZIP correctif via MAJ_MANUELLE.bat dans le dossier permanent.')

    with st.expander('Installer un correctif ZIP depuis cette page (si aucune source automatique n’est configurée)'):
        user_file=st.file_uploader('Fichier ZIP de mise à jour',type=['zip'],key='manual_zip')
        if user_file is not None and st.button('Préparer cette mise à jour pour le prochain lancement'):
            import hashlib, shutil
            from update_manager import prepare_update
            try:
                if user_file.size>30*1024*1024:raise ValueError('Fichier trop volumineux')
                (base/'updates').mkdir(parents=True,exist_ok=True)
                temporary=base/'updates'/'manual_upload.tmp.zip'
                with temporary.open('wb') as f:
                    while chunk:=user_file.read(64*1024):f.write(chunk)
                stage,version=prepare_update(base,temporary)
                shutil.rmtree(stage,ignore_errors=True)
                target=base/'updates'/'pending.zip'
                temporary.replace(target)
                digest=hashlib.sha256(target.read_bytes()).hexdigest()
                (base/'updates'/'pending.json').write_text(__import__('json').dumps({'version':version,'sha256':digest}),encoding='utf-8')
                st.success('Version '+version+' prête. Ferme puis relance l’application pour installer le correctif.')
            except Exception as ex:st.error(str(ex))
            finally:
                (base/'updates'/'manual_upload.tmp.zip').unlink(missing_ok=True)
