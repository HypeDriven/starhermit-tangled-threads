// sh-i18n.js — strings for the StarHermit platform controls (sign-in,
// invite) in every supported locale, picked from navigator.language.
const en = {
  signIn: 'Sign in with StarHermit', invite: 'Invite a friend',
  copied: 'Invite link copied to the clipboard', copyFail: 'Copy this invite link: {url}',
  signedOut: 'Signed out — progress stays on this device',
  lbPosting: 'Posting score to the leaderboard…', lbRank: 'Leaderboard rank: #{rank}', lbPosted: 'Score posted to the leaderboard.', lbNotPosted: 'Score not posted to the leaderboard.',
};
const es = {
  signIn: 'Iniciar sesión con StarHermit', invite: 'Invitar a un amigo',
  copied: 'Enlace de invitación copiado al portapapeles', copyFail: 'Copia este enlace de invitación: {url}',
  signedOut: 'Sesión cerrada: el progreso se queda en este dispositivo',
  lbPosting: 'Enviando la puntuación a la clasificación…', lbRank: 'Puesto en la clasificación: #{rank}', lbPosted: 'Puntuación enviada a la clasificación.', lbNotPosted: 'La puntuación no se envió a la clasificación.',
};
const fr = {
  signIn: 'Se connecter avec StarHermit', invite: 'Inviter un ami',
  copied: 'Lien d’invitation copié dans le presse-papiers', copyFail: 'Copiez ce lien d’invitation : {url}',
  signedOut: 'Déconnecté — la progression reste sur cet appareil',
  lbPosting: 'Envoi du score au classement…', lbRank: 'Rang au classement : #{rank}', lbPosted: 'Score envoyé au classement.', lbNotPosted: 'Score non envoyé au classement.',
};
export const SH_STRINGS = {
  'en-US': en, 'en-GB': en, 'es-419': es, 'es-ES': { ...es, lbNotPosted: 'La puntuación no se ha enviado a la clasificación.' },
  'de-DE': {
    signIn: 'Mit StarHermit anmelden', invite: 'Freund einladen',
    copied: 'Einladungslink in die Zwischenablage kopiert', copyFail: 'Kopiere diesen Einladungslink: {url}',
    signedOut: 'Abgemeldet – der Fortschritt bleibt auf diesem Gerät',
    lbPosting: 'Punktzahl wird an die Bestenliste gesendet…', lbRank: 'Platz in der Bestenliste: #{rank}', lbPosted: 'Punktzahl an die Bestenliste gesendet.', lbNotPosted: 'Punktzahl nicht an die Bestenliste gesendet.',
  },
  'fr-FR': fr, 'fr-CA': { ...fr, lbPosting: 'Envoi du pointage au classement…', lbPosted: 'Pointage envoyé au classement.', lbNotPosted: 'Pointage non envoyé au classement.' },
  'pt-BR': {
    signIn: 'Entrar com StarHermit', invite: 'Convidar um amigo',
    copied: 'Link de convite copiado para a área de transferência', copyFail: 'Copie este link de convite: {url}',
    signedOut: 'Sessão encerrada — o progresso fica neste dispositivo',
    lbPosting: 'Enviando a pontuação para o placar…', lbRank: 'Posição no placar: #{rank}', lbPosted: 'Pontuação enviada ao placar.', lbNotPosted: 'Pontuação não enviada ao placar.',
  },
  'it-IT': {
    signIn: 'Accedi con StarHermit', invite: 'Invita un amico',
    copied: 'Link di invito copiato negli appunti', copyFail: 'Copia questo link di invito: {url}',
    signedOut: 'Disconnesso: i progressi restano su questo dispositivo',
    lbPosting: 'Invio del punteggio alla classifica…', lbRank: 'Posizione in classifica: #{rank}', lbPosted: 'Punteggio inviato alla classifica.', lbNotPosted: 'Punteggio non inviato alla classifica.',
  },
};
const BY_LANG = { en: 'en-US', es: 'es-419', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };

export function shLocale(tag) {
  const t = String(tag || 'en-US');
  const exact = Object.keys(SH_STRINGS).find(k => k.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const lang = t.split('-')[0].toLowerCase();
  if (lang === 'es' && /-es$/i.test(t)) return 'es-ES';
  if (lang === 'en' && /-(gb|ie|au|nz|za|in)$/i.test(t)) return 'en-GB';
  if (lang === 'fr' && /-ca$/i.test(t)) return 'fr-CA';
  return BY_LANG[lang] || 'en-US';
}

export function shText(key, vars = {}, tag = (typeof navigator !== 'undefined' ? navigator.language : 'en-US')) {
  const s = SH_STRINGS[shLocale(tag)][key] ?? en[key];
  return String(s).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}
