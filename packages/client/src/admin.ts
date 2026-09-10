// admin.html is retired: the rules editor now lives INSIDE the Loom (the unified view+alter surface —
// Structuur / Grafiek / Regels for any cassette). This file is kept only so old links keep working:
// /admin.html?model=<id> → the Loom's rules tab for that cassette. The editor code moved verbatim to
// src/loom/rules-edit.ts, which the Loom hosts as its "Regels" tab.

const model = new URLSearchParams(location.search).get('model');
location.replace(model ? `/loom.html?cassette=${encodeURIComponent(model)}#regels` : '/loom.html');
