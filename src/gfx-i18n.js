// Tangled Threads — strings for the Graphics settings tab, per locale.
// The rest of the game is English-only; the Graphics tab follows navigator.language.

const en = {
  tabGeneral: 'General', tabGraphics: 'Graphics', heading: 'Graphics',
  quality: 'Quality', auto: 'Auto (detected: {tier})',
  preset: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
  renderScale: 'Render scale', fromPreset: 'From preset ({tier})',
  cat: {
    shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade and vignette',
    antialias: 'Anti-aliasing', reflections: 'Reflections (environment light)', detail: 'Surface detail',
    particles: 'Particles', ambient: 'Ambient motion',
  },
  tier: {
    off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', plain: 'Plain', detailed: 'Detailed',
    static: 'Static', animated: 'Animated', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
  },
  adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
  postFailed: 'Post-processing is unavailable on this device; the game renders without it.',
  unknownGpu: 'unknown GPU',
  summary: {
    noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion',
    bloom: 'bloom', reflections: 'reflections', noAA: 'no anti-aliasing', px: '{w}×{h} px',
  },
};

const enGB = {
  ...en,
  cat: { ...en.cat, grade: 'Colour grade and vignette' },
};

const es419 = {
  tabGeneral: 'General', tabGraphics: 'Gráficos', heading: 'Gráficos',
  quality: 'Calidad', auto: 'Automática (detectada: {tier})',
  preset: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  renderScale: 'Escala de renderizado', fromPreset: 'Según el ajuste ({tier})',
  cat: {
    shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color y viñeta',
    antialias: 'Antialiasing', reflections: 'Reflejos (luz del entorno)', detail: 'Detalle de superficies',
    particles: 'Partículas', ambient: 'Movimiento ambiental',
  },
  tier: {
    off: 'No', on: 'Sí', low: 'Bajo', medium: 'Medio', high: 'Alto', plain: 'Simple', detailed: 'Detallado',
    static: 'Estático', animated: 'Animado', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
  },
  adaptive: 'Resolución adaptativa', showFps: 'Mostrar cuadros por segundo',
  postFailed: 'El posprocesado no está disponible en este dispositivo; el juego se muestra sin él.',
  unknownGpu: 'GPU desconocida',
  summary: {
    noShadows: 'sin sombras', shadows: 'sombras {n}²', ao: 'oclusión ambiental', aoHigh: 'oclusión ambiental completa',
    bloom: 'resplandor', reflections: 'reflejos', noAA: 'sin antialiasing', px: '{w}×{h} px',
  },
};

const esES = {
  ...es419,
  renderScale: 'Escala de renderizado', showFps: 'Mostrar fotogramas por segundo',
  postFailed: 'El posprocesado no está disponible en este dispositivo; el juego se muestra sin él.',
};

const de = {
  tabGeneral: 'Allgemein', tabGraphics: 'Grafik', heading: 'Grafik',
  quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})',
  preset: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
  renderScale: 'Renderskalierung', fromPreset: 'Laut Voreinstellung ({tier})',
  cat: {
    shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Leuchteffekt', grade: 'Farbkorrektur und Vignette',
    antialias: 'Kantenglättung', reflections: 'Spiegelungen (Umgebungslicht)', detail: 'Oberflächendetails',
    particles: 'Partikel', ambient: 'Umgebungsbewegung',
  },
  tier: {
    off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', plain: 'Schlicht', detailed: 'Detailliert',
    static: 'Statisch', animated: 'Animiert', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
  },
  adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
  postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; das Spiel wird ohne sie dargestellt.',
  unknownGpu: 'unbekannte GPU',
  summary: {
    noShadows: 'keine Schatten', shadows: '{n}²-Schatten', ao: 'Umgebungsverdeckung', aoHigh: 'volle Umgebungsverdeckung',
    bloom: 'Leuchteffekt', reflections: 'Spiegelungen', noAA: 'keine Kantenglättung', px: '{w}×{h} px',
  },
};

const fr = {
  tabGeneral: 'Général', tabGraphics: 'Graphismes', heading: 'Graphismes',
  quality: 'Qualité', auto: 'Automatique (détectée : {tier})',
  preset: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra' },
  renderScale: 'Échelle de rendu', fromPreset: 'Selon le préréglage ({tier})',
  cat: {
    shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage et vignettage',
    antialias: 'Anticrénelage', reflections: "Reflets (lumière d'ambiance)", detail: 'Détail des surfaces',
    particles: 'Particules', ambient: 'Mouvement ambiant',
  },
  tier: {
    off: 'Désactivé', on: 'Activé', low: 'Bas', medium: 'Moyen', high: 'Élevé', plain: 'Simple', detailed: 'Détaillé',
    static: 'Statique', animated: 'Animé', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
  },
  adaptive: 'Résolution adaptative', showFps: 'Afficher la fréquence d’images',
  postFailed: 'Le post-traitement est indisponible sur cet appareil ; le jeu s’affiche sans lui.',
  unknownGpu: 'GPU inconnu',
  summary: {
    noShadows: 'sans ombres', shadows: 'ombres {n}²', ao: 'occlusion ambiante', aoHigh: 'occlusion ambiante complète',
    bloom: 'halo', reflections: 'reflets', noAA: 'sans anticrénelage', px: '{w}×{h} px',
  },
};

const frCA = {
  ...fr,
  tabGraphics: 'Graphiques', heading: 'Graphiques',
  showFps: 'Afficher le nombre d’images par seconde',
};

const ptBR = {
  tabGeneral: 'Geral', tabGraphics: 'Gráficos', heading: 'Gráficos',
  quality: 'Qualidade', auto: 'Automática (detectada: {tier})',
  preset: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  renderScale: 'Escala de renderização', fromPreset: 'Conforme a predefinição ({tier})',
  cat: {
    shadows: 'Sombras', ao: 'Oclusão ambiente', bloom: 'Brilho', grade: 'Correção de cor e vinheta',
    antialias: 'Antisserrilhamento', reflections: 'Reflexos (luz do ambiente)', detail: 'Detalhe das superfícies',
    particles: 'Partículas', ambient: 'Movimento ambiente',
  },
  tier: {
    off: 'Desligado', on: 'Ligado', low: 'Baixo', medium: 'Médio', high: 'Alto', plain: 'Simples', detailed: 'Detalhado',
    static: 'Estático', animated: 'Animado', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
  },
  adaptive: 'Resolução adaptativa', showFps: 'Mostrar taxa de quadros',
  postFailed: 'O pós-processamento não está disponível neste dispositivo; o jogo é exibido sem ele.',
  unknownGpu: 'GPU desconhecida',
  summary: {
    noShadows: 'sem sombras', shadows: 'sombras {n}²', ao: 'oclusão ambiente', aoHigh: 'oclusão ambiente completa',
    bloom: 'brilho', reflections: 'reflexos', noAA: 'sem antisserrilhamento', px: '{w}×{h} px',
  },
};

const it = {
  tabGeneral: 'Generale', tabGraphics: 'Grafica', heading: 'Grafica',
  quality: 'Qualità', auto: 'Automatica (rilevata: {tier})',
  preset: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
  renderScale: 'Scala di rendering', fromPreset: 'Dal preset ({tier})',
  cat: {
    shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore e vignettatura',
    antialias: 'Antialiasing', reflections: "Riflessi (luce d'ambiente)", detail: 'Dettaglio delle superfici',
    particles: 'Particelle', ambient: 'Movimento ambientale',
  },
  tier: {
    off: 'No', on: 'Sì', low: 'Basso', medium: 'Medio', high: 'Alto', plain: 'Semplice', detailed: 'Dettagliato',
    static: 'Statico', animated: 'Animato', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
  },
  adaptive: 'Risoluzione adattiva', showFps: 'Mostra frame rate',
  postFailed: 'La post-elaborazione non è disponibile su questo dispositivo; il gioco viene mostrato senza.',
  unknownGpu: 'GPU sconosciuta',
  summary: {
    noShadows: 'senza ombre', shadows: 'ombre {n}²', ao: 'occlusione ambientale', aoHigh: 'occlusione ambientale completa',
    bloom: 'bagliore', reflections: 'riflessi', noAA: 'senza antialiasing', px: '{w}×{h} px',
  },
};

export const GFX_STRINGS = {
  'en-US': en, 'en-GB': enGB, 'es-419': es419, 'es-ES': esES, 'de-DE': de,
  'fr-FR': fr, 'fr-CA': frCA, 'pt-BR': ptBR, 'it-IT': it,
};

/** Best supported locale for a BCP 47 tag (exact, then regional rules, then language). */
export function pickLocale(tag) {
  const t = String(tag || 'en-US');
  if (GFX_STRINGS[t]) return t;
  const [lang, region = ''] = t.split('-');
  if (lang === 'en') return ['GB', 'IE', 'AU', 'NZ', 'ZA', 'IN'].includes(region.toUpperCase()) ? 'en-GB' : 'en-US';
  if (lang === 'es') return region.toUpperCase() === 'ES' || !region ? 'es-ES' : 'es-419';
  if (lang === 'fr') return region.toUpperCase() === 'CA' ? 'fr-CA' : 'fr-FR';
  if (lang === 'pt') return 'pt-BR';
  if (lang === 'de') return 'de-DE';
  if (lang === 'it') return 'it-IT';
  return 'en-US';
}

export function gfxStrings(tag) {
  return GFX_STRINGS[pickLocale(tag)];
}
