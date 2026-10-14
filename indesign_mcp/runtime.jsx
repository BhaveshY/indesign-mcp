// InDesign MCP runtime (ExtendScript / ES3). Loaded once into the persistent engine "indesign_mcp";
// the server then calls $.global.__idmcp.run(args, tool) (~1 ms instead of re-parsing this file every call).
// Coordinates: x,y,w,h relative to the item's page top-left, in A.units (default mm). Pages are 1-based.
$.global.__idmcp = { v: '%VERSION%', run: function (A, TOOL) {
A = A || {};

// ---------- JSON ----------
var ESC = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };
function q(s) {
  return '"' + String(s).replace(/[\\"\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/g, function (c) {
    return ESC[c] || ('\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
  }) + '"';
}
function J(v, d) {
  d = d || 0;
  if (v === null || v === undefined) return 'null';
  var t = typeof v;
  if (t === 'number') return isFinite(v) ? String(Math.round(v * 1000) / 1000) : 'null';
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'string') return q(v);
  if (t === 'function') return 'null';
  if (d > 10) return q(String(v));
  var i, a = [];
  if (v instanceof Array) { for (i = 0; i < v.length; i++) a.push(J(v[i], d + 1)); return '[' + a.join(',') + ']'; }
  if (v instanceof File || v instanceof Folder) return q(v.fsName);
  if (v instanceof UnitValue) return String(v.value);
  var cn = ctor(v);
  if (cn === 'Enumerator') return q(enumName(null, v));
  if (cn && cn !== 'Object') return J(ref(v), d + 1);
  for (var k in v) if (v.hasOwnProperty(k) && v[k] !== undefined) a.push(q(k) + ':' + J(v[k], d + 1));
  return '{' + a.join(',') + '}';
}
function ctor(v) { try { return v.constructor.name; } catch (e) { return ''; } }

// ---------- errors / utils ----------
function E(code, msg, next) { var e = new Error(msg); e.code = code; if (next) e.next = next; return e; }
function has(a, v) { for (var i = 0; i < a.length; i++) if (a[i] === v) return true; return false; }
function r2(n) { return Math.round(n * 100) / 100; }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + '\u2026' : s; }
function isNum(v) { return typeof v === 'number' && isFinite(v); }
function lower(s) { return String(s).toLowerCase(); }
function valid(o) { try { return o && o.isValid; } catch (e) { return false; } }

function enumName(cls, v) {
  var n = +v;
  if (n === +NothingEnum.NOTHING) return 'NOTHING';   // "unspecified" sentinel (e.g. style attributes left open)
  var cands = cls ? [cls] : [];
  for (var c = 0; c < cands.length; c++) {
    var C = $.global[cands[c]];
    if (C) for (var k in C) { try { if (+C[k] === n) return k; } catch (e) {} }
  }
  return String(n);
}
// Resolve "CENTER_ALIGN" for property `key` of `obj`; returns enumerator or the original value.
function enumVal(key, v, errMsg) {
  if (typeof v !== 'string' || !/^[A-Z0-9_]+$/.test(v)) return v;
  var names = [cap(key)];
  if (errMsg) { var m = String(errMsg).match(/[A-Z][A-Za-z]+/g); if (m) names = names.concat(m); }
  for (var i = 0; i < names.length; i++) { var C = $.global[names[i]]; if (C && C[v] !== undefined && ctor(C[v]) === 'Enumerator') return C[v]; }
  return v;
}

// ---------- documents / pages / lookup ----------
var D;
function doc(sel, optional) {
  if (!app.documents.length) { if (optional) return null; throw E('no_document', 'No document is open.', 'indesign_document action=open|new'); }
  if (sel === undefined || sel === null || sel === '') return app.activeDocument;
  if (isNum(sel)) { var dd = app.documents[sel - 1]; if (valid(dd)) return dd; }
  for (var i = 0; i < app.documents.length; i++) {
    var x = app.documents[i], fp = '';
    try { fp = x.fullName.fsName; } catch (e) {}
    if (x.name === sel || lower(fp) === lower(sel) || lower(x.name) === lower(sel)) return x;
  }
  throw E('not_found', 'Document not found: ' + sel, 'indesign_status lists open documents');
}
function pageNo(pg) { return pg.documentOffset + 1; }
function page(sel, d) {
  d = d || D;
  if (sel === undefined || sel === null) {
    try { var w = app.activeWindow; if (w.parent === d || w.parent.id === d.id) return w.activePage; } catch (e) {}
    return d.pages[0];
  }
  if (isNum(sel)) { if (sel < 1 || sel > d.pages.length) throw E('not_found', 'Page ' + sel + ' out of range 1..' + d.pages.length); return d.pages[sel - 1]; }
  var p = d.pages.itemByName(String(sel));
  if (valid(p)) return p;
  throw E('not_found', 'Page not found: ' + sel, 'pages are 1-based numbers');
}
function pageList(sel, d) {
  d = d || D; var out = [], i;
  if (sel === undefined || sel === null || sel === 'all') { for (i = 0; i < d.pages.length; i++) out.push(d.pages[i]); return out; }
  if (!(sel instanceof Array)) {
    var m = String(sel).match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) { for (i = +m[1]; i <= +m[2]; i++) out.push(page(i, d)); return out; }
    return [page(sel, d)];
  }
  for (i = 0; i < sel.length; i++) out.push(page(sel[i], d));
  return out;
}
function spec(o) { try { var e = o.getElements(); return e.length ? e[0] : o; } catch (x) { return o; } }
// Find a page item (or story/table) by numeric id, or by item name / script label.
function item(sel, kinds) {
  if (sel === undefined || sel === null) throw E('bad_args', 'Missing item id');
  if (typeof sel === 'object' && sel.isValid) return sel;
  var it;
  if (isNum(sel) || /^\d+$/.test(sel)) {
    sel = +sel;
    it = D.pageItems.itemByID(sel); if (valid(it)) return spec(it);
    it = D.stories.itemByID(sel); if (valid(it)) return it;
    var all = D.allPageItems;
    for (var i = 0; i < all.length; i++) if (all[i].id === sel) return all[i];
    try { it = D.links.itemByID(sel); if (valid(it)) return it; } catch (e) {}
    for (i = 0; i < D.stories.length; i++) { var ts = D.stories[i].tables; if (ts.length) { it = ts.itemByID(sel); if (valid(it)) return it; } }
    throw E('not_found', 'No item with id ' + sel, 'indesign_read what=items to list ids');
  }
  var a = D.allPageItems;
  for (var j = 0; j < a.length; j++) { try { if (a[j].name === sel || a[j].label === sel) return a[j]; } catch (e2) {} }
  throw E('not_found', 'No item named/labelled "' + sel + '"', 'use a numeric id from indesign_read what=items');
}
function items(sel) { var o = [], s = sel instanceof Array ? sel : [sel]; for (var i = 0; i < s.length; i++) o.push(item(s[i])); return o; }
function story(sel) {
  var it = item(sel);
  if (it.constructor.name === 'Story') return it;
  if (it.parentStory) return it.parentStory;
  if (it.constructor.name === 'Table') return it.storyOffset.parentStory;
  throw E('bad_target', 'Item ' + sel + ' (' + it.constructor.name + ') has no text', 'pass a text frame or story id');
}
function textOf(it) {
  var c = it.constructor.name;
  if (c === 'Story' || c === 'Cell') return it.texts[0];
  if (c === 'TextFrame') return it.parentStory.texts[0];
  if (it.parentStory) return it.parentStory.texts[0];
  throw E('bad_target', c + ' has no text');
}

// ---------- name resolvers ----------
function findStyle(coll, name) {
  var all = coll, s;
  s = all.itemByName(name); if (valid(s)) return s;
  for (var i = 0; i < all.length; i++) if (lower(all[i].name) === lower(name)) return all[i];
  return null;
}
var STYLE_KIND = { paragraph: 'allParagraphStyles', character: 'allCharacterStyles', object: 'allObjectStyles', table: 'allTableStyles', cell: 'allCellStyles' };
function styleByKind(kind, name, must) {
  var arr = D[STYLE_KIND[kind]]; if (!arr) throw E('bad_args', 'Unknown style kind ' + kind);
  for (var i = 0; i < arr.length; i++) if (arr[i].name === name) return arr[i];
  for (i = 0; i < arr.length; i++) if (lower(arr[i].name) === lower(name)) return arr[i];
  if (must !== false) {
    var names = []; for (i = 0; i < arr.length && i < 40; i++) names.push(arr[i].name);
    throw E('not_found', cap(kind) + ' style "' + name + '" not found', 'available: ' + names.join(', '));
  }
  return null;
}
function swatch(name) {
  if (name === null || lower(name) === 'none') return D.swatches.itemByName('None');
  var s = findStyle(D.swatches, name); if (s) return s;
  throw E('not_found', 'Swatch "' + name + '" not found', 'create it with op=swatch or use indesign_read what=swatches');
}
function layer(name, create) {
  var l = D.layers.itemByName(name); if (valid(l)) return l;
  for (var i = 0; i < D.layers.length; i++) if (lower(D.layers[i].name) === lower(name)) return D.layers[i];
  if (create) { var act = D.activeLayer, nl = D.layers.add({ name: name }); try { D.activeLayer = act; } catch (e) {} return nl; }
  throw E('not_found', 'Layer "' + name + '" not found');
}
function master(name) {
  if (name === null || lower(name) === 'none') return NothingEnum.NOTHING;
  for (var i = 0; i < D.masterSpreads.length; i++) { var m = D.masterSpreads[i]; if (m.name === name || m.namePrefix === name || lower(m.name) === lower(name)) return m; }
  throw E('not_found', 'Master "' + name + '" not found');
}
var REF_KEYS = {
  fillColor: swatch, strokeColor: swatch, gapColor: swatch, underlineColor: swatch, strikeThroughColor: swatch, ruleAboveColor: swatch, ruleBelowColor: swatch,
  appliedParagraphStyle: function (n) { return styleByKind('paragraph', n); }, appliedCharacterStyle: function (n) { return styleByKind('character', n); },
  appliedObjectStyle: function (n) { return styleByKind('object', n); }, appliedTableStyle: function (n) { return styleByKind('table', n); },
  appliedCellStyle: function (n) { return styleByKind('cell', n); }, itemLayer: function (n) { return layer(n); }, appliedMaster: master
};
// Short aliases accepted everywhere props are accepted.
var ALIAS = { fill: 'fillColor', stroke: 'strokeColor', weight: 'strokeWeight', font: 'appliedFont', size: 'pointSize', color: 'fillColor',
  para_style: 'appliedParagraphStyle', char_style: 'appliedCharacterStyle', object_style: 'appliedObjectStyle', layer: 'itemLayer',
  master: 'appliedMaster', rotation: 'rotationAngle', tint: 'fillTint', align: 'justification', style_name: 'fontStyle' };
var ALIGN = { left: 'LEFT_ALIGN', center: 'CENTER_ALIGN', right: 'RIGHT_ALIGN', justify: 'LEFT_JUSTIFIED', full: 'FULLY_JUSTIFIED' };
function setProps(obj, props, styleKind) {
  if (!props) return;
  for (var k0 in props) {
    if (!props.hasOwnProperty(k0)) continue;
    var k = ALIAS[k0] || k0, v = props[k0];
    if (k0 === 'style') k = styleKind === 'object' ? 'appliedObjectStyle' : 'appliedParagraphStyle';
    if (k === 'justification' && ALIGN[v]) v = ALIGN[v];
    if (k === 'opacity') { obj.transparencySettings.blendingSettings.opacity = v; continue; }
    if (k === 'basedOn' || k === 'nextStyle') { if (typeof v === 'string') v = styleByKind(styleKind || 'paragraph', v); }
    else if (REF_KEYS[k] && typeof v === 'string') v = REF_KEYS[k](v);
    if (v && typeof v === 'object' && !(v instanceof Array) && ctor(v) === 'Object') { setProps(obj[k], v, styleKind); continue; }
    v = enumVal(k, v);
    try { obj[k] = v; }
    catch (e) {
      var v2 = enumVal(k, props[k0], e.message);
      if (v2 !== v) { obj[k] = v2; continue; }
      throw E('bad_property', 'Cannot set ' + k + '=' + trunc(J(props[k0]), 60) + ' on ' + ctor(obj) + ': ' + e.message, 'check the property name/value (InDesign CS6 DOM)');
    }
  }
}

// ---------- geometry ----------
function origin(it) { var pg = null; try { pg = it.parentPage; } catch (e) {} if (!pg) return [0, 0, null]; var b = pg.bounds; return [b[1], b[0], pg]; }
// InDesign runs in points; U = points per user unit. iu: user->pt, ou: pt->user (rounded).
var U = 1;
function iu(v) { return v * U; }
function ou(v) { return r2(v / U); }
function toGB(pg, x, y, w, h) { var b = pg.bounds; return [b[0] + y * U, b[1] + x * U, b[0] + (y + h) * U, b[1] + (x + w) * U]; }
function box(it) {
  var gb = it.geometricBounds, o = origin(it);
  return { x: ou(gb[1] - o[0]), y: ou(gb[0] - o[1]), w: ou(gb[3] - gb[1]), h: ou(gb[2] - gb[0]), pg: o[2] };
}
function applyBox(it, a) {
  if (!(isNum(a.x) || isNum(a.y) || isNum(a.w) || isNum(a.h) || isNum(a.dx) || isNum(a.dy))) return;
  var b = box(it), pg = b.pg;
  if (a.page !== undefined) pg = page(a.page);
  if (!pg) pg = page(null);
  var x = isNum(a.x) ? a.x : b.x, y = isNum(a.y) ? a.y : b.y;
  if (isNum(a.dx)) x += a.dx; if (isNum(a.dy)) y += a.dy;
  var w = isNum(a.w) ? a.w : b.w, h = isNum(a.h) ? a.h : b.h;
  if (!isNum(a.w) && !isNum(a.h) && it.rotationAngle) { var gb = it.geometricBounds, t = toGB(pg, x, y, w, h); it.move(undefined, [t[1] - gb[1], t[0] - gb[0]]); return; }
  it.geometricBounds = toGB(pg, x, y, w, h);
}

// ---------- descriptions ----------
function ref(o) { var r = { type: ctor(o) }; try { r.id = o.id; } catch (e) {} try { if (o.name) r.name = o.name; } catch (e2) {} return r; }
function nm(o) { try { return o && o.isValid ? o.name : null; } catch (e) { return null; } }
function info(it, full) {
  var t = ctor(it), o = { id: it.id, type: t };
  if (t === 'Story') { o.chars = it.characters.length; o.overset = it.overflows; o.text = trunc(it.contents, 80); return o; }
  try {
    var b = box(it); if (b.pg) o.page = pageNo(b.pg); else o.page = null;
    o.x = b.x; o.y = b.y; o.w = b.w; o.h = b.h;
  } catch (e) {}
  try { if (it.name) o.name = it.name; } catch (e1) {}
  try { if (it.label) o.label = trunc(it.label, 60); } catch (e2) {}
  try { if (it.rotationAngle) o.rot = r2(it.rotationAngle); } catch (e3) {}
  try { o.layer = it.itemLayer.name; } catch (e4) {}
  try { var f = nm(it.fillColor); if (f && f !== 'None') o.fill = f; var s = nm(it.strokeColor); if (s && s !== 'None' && it.strokeWeight) { o.stroke = s; o.sw = r2(it.strokeWeight); } } catch (e5) {}
  try { if (!it.visible) o.hidden = true; if (it.locked) o.locked = true; } catch (e6) {}
  if (t === 'TextFrame') {
    o.story = it.parentStory.id;
    o.text = trunc(it.contents, full ? 400 : 60);
    if (it.parentStory.overflows) o.overset = true;
    try { var ps = it.paragraphs.length ? it.paragraphs[0].appliedParagraphStyle.name : null; if (ps) o.pstyle = ps; } catch (e7) {}
    if (it.tables.length) o.tables = it.tables.length;
  }
  if (t === 'Group') o.children = it.pageItems.length;
  try {
    if (it.graphics && it.graphics.length) {
      var g = spec(it.graphics[0]); o.graphic = ctor(g);
      try { var l = g.itemLink; o.link = l.name; if (l.status !== LinkStatus.NORMAL) o.linkStatus = enumName('LinkStatus', l.status); } catch (e8) {}
      try { var pp = g.effectivePpi; if (pp) o.ppi = Math.round(Math.min(pp[0], pp[1])); } catch (e9) {}
    }
  } catch (e10) {}
  try { var os = nm(it.appliedObjectStyle); if (full && os) o.ostyle = os; } catch (e11) {}
  if (full) {
    try { o.stroke_w = it.strokeWeight; o.opacity = it.transparencySettings.blendingSettings.opacity; } catch (e12) {}
    if (t === 'TextFrame') {
      try { var tp = it.textFramePreferences; o.columns = tp.textColumnCount; o.inset_pt = tp.insetSpacing; o.vjust = enumName('VerticalJustification', tp.verticalJustification); } catch (e13) {}
      // Formatting of the first character (pt), so text size/font can be verified without a separate text read.
      try { var c0 = it.parentStory.characters[0]; if (valid(c0)) o.text_format = { font: c0.appliedFont.name, size: c0.pointSize, leading: c0.leading === Leading.AUTO ? 'AUTO' : c0.leading, color: nm(c0.fillColor), pstyle: nm(c0.appliedParagraphStyle), cstyle: nm(c0.appliedCharacterStyle) }; } catch (e14) {}
    }
  }
  return o;
}
function pageInfo(pg) {
  var b = pg.bounds, o = { page: pageNo(pg), name: pg.name, w: ou(b[3] - b[1]), h: ou(b[2] - b[0]), items: pg.pageItems.length };
  try { o.master = pg.appliedMaster ? pg.appliedMaster.name : null; } catch (e) { o.master = null; }
  try { o.side = enumName('PageSideOptions', pg.side); } catch (e2) {}
  try { var m = marginBox(pg); o.margin_box = [ou(m[0]), ou(m[1]), ou(m[2]), ou(m[3])]; o.columns = pg.marginPreferences.columnCount; o.gutter = ou(pg.marginPreferences.columnGutter); } catch (e3) {}
  return o;
}
function propVal(k, v) {
  if (ctor(v) === 'Enumerator') return enumName(cap(k), v);
  if (typeof v === 'object' && v !== null && !(v instanceof Array) && ctor(v) !== 'Object' && !(v instanceof File)) { try { return v.name !== undefined ? v.name : ref(v); } catch (e) { return ctor(v); } }
  return v;
}
function propsOf(o, keys) {
  var p = o.properties, out = {};
  for (var k in p) {
    if (keys && !has(keys, k)) continue;
    var v = p[k];
    if (v === null || v === undefined || typeof v === 'function') continue;
    out[k] = propVal(k, v);
  }
  return out;
}
// Requested props for `what=item`: item first, then (for text containers) the first character; unknown names reported.
function itemProps(it, keys) {
  if (keys === true) return { props: propsOf(it) };
  var out = propsOf(it, keys), txt = null, miss = [], i;
  try { if (it.parentStory) txt = it.parentStory.characters[0]; else if (ctor(it) === 'Story') txt = it.characters[0]; } catch (e) {}
  for (i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (out.hasOwnProperty(k)) continue;
    var v; try { v = it[k]; } catch (e1) { v = undefined; }
    if (v === undefined && valid(txt)) { try { v = txt[k]; if (v !== undefined) k = 'text.' + k; } catch (e2) { v = undefined; } }
    if (v === undefined) miss.push(keys[i]); else out[k] = propVal(keys[i], v);
  }
  var r = { props: out };
  if (miss.length) r.unsupported = miss;
  return r;
}
function page2(list, a, def) {
  var off = a.offset || 0, lim = a.limit || def || 100, out = [];
  for (var i = off; i < list.length && out.length < lim; i++) out.push(list[i]);
  var r = { total: list.length, items: out };
  if (off + out.length < list.length) r.next_offset = off + out.length;
  return r;
}

// ---------- read ----------
function issues(d, max) {
  var out = { overset: [], links: [], fonts: [] }, i;
  for (i = 0; i < d.stories.length && out.overset.length < max; i++) {
    var s = d.stories[i];
    if (s.overflows) { var tf = s.textContainers.length ? s.textContainers[s.textContainers.length - 1] : null; out.overset.push({ story: s.id, frame: tf ? tf.id : null, text: trunc(s.contents, 40) }); }
  }
  for (i = 0; i < d.links.length && out.links.length < max; i++) {
    var l = d.links[i];
    if (l.status !== LinkStatus.NORMAL) out.links.push({ id: l.id, name: l.name, status: enumName('LinkStatus', l.status) });
  }
  var f = d.fonts.everyItem().getElements();
  for (i = 0; i < f.length && out.fonts.length < max; i++) {
    if (f[i].status !== FontStatus.INSTALLED) out.fonts.push({ name: f[i].name, status: enumName('FontStatus', f[i].status) });
  }
  return out;
}
function docInfo(d, brief) {
  var dp = d.documentPreferences, o = { name: d.name };
  try { o.path = d.fullName.fsName; } catch (e) { o.path = null; }
  o.modified = d.modified;
  o.pages = d.pages.length;
  if (brief) return o;
  o.size = { w: ou(dp.pageWidth), h: ou(dp.pageHeight), units: A.units || 'mm' };
  o.facing = dp.facingPages; o.spreads = d.spreads.length;
  o.bleed = [ou(dp.documentBleedTopOffset), ou(dp.documentBleedOutsideOrRightOffset), ou(dp.documentBleedBottomOffset), ou(dp.documentBleedInsideOrLeftOffset)];
  var mp = d.pages[0].marginPreferences;
  o.margins = [ou(mp.top), ou(mp.right), ou(mp.bottom), ou(mp.left)]; o.columns = mp.columnCount; o.gutter = ou(mp.columnGutter);
  var ls = []; for (var i = 0; i < d.layers.length; i++) { var L = d.layers[i]; ls.push(L.name + (L.visible ? '' : ' (hidden)') + (L.locked ? ' (locked)' : '')); }
  o.layers = ls;
  var ms = []; for (i = 0; i < d.masterSpreads.length; i++) ms.push(d.masterSpreads[i].name); o.masters = ms;
  // items = top-level items on spreads incl. pasteboard (same scope as read what=items); all_items adds group children + placed graphics.
  var top = 0; for (var sp0 = 0; sp0 < d.spreads.length; sp0++) top += d.spreads[sp0].pageItems.length;
  o.counts = { items: top, all_items: d.allPageItems.length, stories: d.stories.length, links: d.links.length, tables: 0, pstyles: d.allParagraphStyles.length, cstyles: d.allCharacterStyles.length, ostyles: d.allObjectStyles.length, swatches: d.swatches.length };
  for (i = 0; i < d.stories.length; i++) o.counts.tables += d.stories[i].tables.length;
  o.issues = issues(d, 10);
  return o;
}
var GRAPHIC = { Image: 1, EPS: 1, PDF: 1, PICT: 1, WMF: 1, ImportedPage: 1, Graphic: 1 };
function filterItems(a) {
  var src, out = [], i;
  if (a.ids) return items(a.ids);
  if (a.page !== undefined && a.page !== null) {
    var pgs = pageList(a.page);
    for (i = 0; i < pgs.length; i++) { var c = a.nested ? pgs[i].allPageItems : pgs[i].pageItems.everyItem().getElements(); for (var j = 0; j < c.length; j++) out.push(c[j]); }
    src = out; out = [];
  } else if (a.nested) src = D.allPageItems;
  else { src = []; for (i = 0; i < D.spreads.length; i++) { var e = D.spreads[i].pageItems.everyItem().getElements(); for (var k = 0; k < e.length; k++) src.push(e[k]); } }
  var type = a.type ? lower(a.type) : null, lay = a.layer ? lower(a.layer) : null, nmq = a.name ? lower(a.name) : null, txt = a.text ? lower(a.text) : null;
  for (i = 0; i < src.length; i++) {
    var it = src[i];
    if (type ? lower(ctor(it)).indexOf(type) < 0 : (a.nested && GRAPHIC[ctor(it)])) continue;
    if (lay) { try { if (lower(it.itemLayer.name) !== lay) continue; } catch (e1) { continue; } }
    if (nmq) { var n = ''; try { n = lower(it.name + ' ' + it.label); } catch (e2) {} if (n.indexOf(nmq) < 0) continue; }
    if (txt) { var c2 = ''; try { c2 = lower(it.contents); } catch (e3) {} if (typeof c2 !== 'string' || c2.indexOf(txt) < 0) continue; }
    out.push(it);
  }
  return out;
}
function storyText(s, a) {
  var o = { story: s.id, chars: s.characters.length, overset: s.overflows, frames: [] }, i;
  var tc = s.textContainers; for (i = 0; i < tc.length; i++) o.frames.push(tc[i].id);
  var max = a.max_chars || 600;
  if (a.raw) { o.text = trunc(s.contents, a.max_chars || 20000); return o; }
  var ps = s.paragraphs, n = ps.length, off = a.offset || 0, lim = a.limit || 60, out = [];
  o.paragraphs_total = n;
  for (i = off; i < n && out.length < lim; i++) {
    var p = ps[i], e = { i: i, style: p.appliedParagraphStyle.name, text: trunc(p.contents.replace(/\r$/, ''), max) };
    try { var cs = p.appliedCharacterStyle.name; if (cs && cs.charAt(0) !== '[') e.cstyle = cs; } catch (x) {}
    if (a.detail) { e.font = p.appliedFont.name; e.size = p.pointSize; e.color = nm(p.fillColor); }
    out.push(e);
  }
  o.paragraphs = out;
  if (off + out.length < n) o.next_offset = off + out.length;
  return o;
}
function findIn(a) {
  var useGrep = !!a.grep, prefs = useGrep ? app.findGrepPreferences : app.findTextPreferences;
  app.findGrepPreferences = NothingEnum.NOTHING; app.findTextPreferences = NothingEnum.NOTHING;
  app.findChangeTextOptions.caseSensitive = !!a.case; app.findChangeTextOptions.wholeWord = !!a.whole_word;
  app.findChangeGrepOptions.includeMasterPages = app.findChangeTextOptions.includeMasterPages = !!a.masters;
  app.findChangeGrepOptions.includeLockedStoriesForFind = app.findChangeTextOptions.includeLockedStoriesForFind = true;
  if (a.find !== undefined && a.find !== '') prefs.findWhat = a.find;
  if (a.find_props) setProps(prefs, a.find_props);
  var scope = a.id !== undefined ? story(a.id) : D;
  var res = useGrep ? scope.findGrep() : scope.findText();
  return res;
}
function hitInfo(t, full) {
  var o = { text: trunc(t.contents, 120) };
  try { o.story = t.parentStory.id; o.index = t.index; } catch (e) {}
  try { var tf = t.parentTextFrames; if (tf && tf.length) { o.frame = tf[0].id; var pg = tf[0].parentPage; o.page = pg ? pageNo(pg) : null; } else o.overset = true; } catch (e2) {}
  if (full) { try { var s = t.parent, st = Math.max(0, t.index - 40), en = Math.min(s.characters.length, t.index + t.characters.length + 40); var cx = s.characters.itemByRange(st, en - 1).contents; o.context = cx instanceof Array ? cx.join('') : cx; } catch (e3) {} }
  return o;
}
function swatchInfo(s) {
  s = spec(s);   // swatches collection yields generic Swatch; resolve to Color/Tint/Gradient for values
  var o = { name: s.name, type: ctor(s) };
  try { if (o.type === 'Color') { o.space = enumName('ColorSpace', s.space); o.model = enumName('ColorModel', s.model); o.values = s.colorValue; } } catch (e) {}
  try { if (o.type === 'Tint') { o.base = s.baseColor.name; o.tint = s.tintValue; } } catch (e2) {}
  return o;
}
function styleInfo(s, kind, detail) {
  var o = { name: s.name };
  try { if (ctor(s.parent) !== 'Document') o.group = s.parent.name; } catch (e) {}
  if (!detail) return o;
  try { o.basedOn = nm(s.basedOn); } catch (e1) {}
  if (kind === 'paragraph' || kind === 'character') {
    var keys = ['appliedFont', 'fontStyle', 'pointSize', 'leading', 'fillColor', 'tracking', 'justification', 'spaceBefore', 'spaceAfter', 'firstLineIndent', 'leftIndent', 'capitalization', 'hyphenation'];
    for (var i = 0; i < keys.length; i++) { try { var v = s[keys[i]]; if (v === undefined || v === null) continue; if (ctor(v) === 'Enumerator') v = enumName(cap(keys[i]), v); else if (typeof v === 'object' && !(v instanceof Array)) v = nm(v); if (v !== '' && v !== null) o[keys[i]] = v; } catch (e2) {} }
  }
  return o;
}

function read(a) {
  var w = a.what || 'document', i, list;
  switch (w) {
    case 'document': return docInfo(D);
    case 'pages': list = []; var pgs = pageList(a.page); for (i = 0; i < pgs.length; i++) list.push(pageInfo(pgs[i])); return page2(list, a, 200);
    case 'items': {
      var its = filterItems(a), r = page2(its, a, 100);
      for (i = 0; i < r.items.length; i++) r.items[i] = info(r.items[i], a.detail); return r;
    }
    case 'item': {
      var it = item(a.id), o = info(it, true);
      if (a.props) { var pr = itemProps(it, a.props); o.props = pr.props; if (pr.unsupported) o.unsupported = pr.unsupported; }
      return o;
    }
    case 'text': {
      if (a.id !== undefined) return storyText(story(a.id), a);
      list = []; for (i = 0; i < D.stories.length; i++) { var s = D.stories[i]; list.push({ story: s.id, chars: s.characters.length, overset: s.overflows, frames: s.textContainers.length, text: trunc(s.contents, 60) }); }
      return page2(list, a, 100);
    }
    case 'find': {
      var hits = findIn(a), r2_ = page2(hits, a, 50);
      for (i = 0; i < r2_.items.length; i++) r2_.items[i] = hitInfo(r2_.items[i], true);
      app.findGrepPreferences = NothingEnum.NOTHING; app.findTextPreferences = NothingEnum.NOTHING; return r2_;
    }
    case 'styles': {
      var kinds = a.kind ? [a.kind] : ['paragraph', 'character', 'object', 'table', 'cell'], out = {};
      for (var k = 0; k < kinds.length; k++) { var arr = D[STYLE_KIND[kinds[k]]], l = []; if (!arr) throw E('bad_args', 'kind must be paragraph|character|object|table|cell');
        for (i = 0; i < arr.length; i++) l.push(a.detail || a.kind ? styleInfo(arr[i], kinds[k], a.detail) : arr[i].name); out[kinds[k]] = l; }
      return out;
    }
    case 'swatches': list = []; for (i = 0; i < D.swatches.length; i++) list.push(a.detail === false ? D.swatches[i].name : swatchInfo(D.swatches[i])); return list;
    case 'layers': list = []; for (i = 0; i < D.layers.length; i++) { var L = D.layers[i]; list.push({ name: L.name, visible: L.visible, locked: L.locked, printable: L.printable, items: L.allPageItems.length }); } return list;
    case 'links': {
      list = [];
      for (i = 0; i < D.links.length; i++) {
        var ln = D.links[i], st = enumName('LinkStatus', ln.status);
        if (a.status && lower(st).indexOf(lower(a.status)) < 0) continue;
        var e = { id: ln.id, name: ln.name, status: st, path: ln.filePath };
        try { var g = ln.parent, fr = g.parent; e.frame = fr.id; var pg = fr.parentPage; e.page = pg ? pageNo(pg) : null; var pp = g.effectivePpi; if (pp) e.ppi = Math.round(Math.min(pp[0], pp[1])); } catch (x) {}
        list.push(e);
      }
      return page2(list, a, 200);
    }
    case 'fonts': { var f = D.fonts.everyItem().getElements(); list = []; for (i = 0; i < f.length; i++) { var fs = enumName('FontStatus', f[i].status); if (a.status && lower(fs).indexOf(lower(a.status)) < 0) continue; list.push({ name: f[i].name, status: fs }); } return list; }
    case 'selection': { var sel = app.selection, o2 = []; for (i = 0; i < sel.length; i++) { var c = ctor(sel[i]); if (c === 'Text' || c === 'InsertionPoint' || c === 'Word' || c === 'Paragraph' || c === 'Character' || c === 'TextStyleRange' || c === 'Line') o2.push(hitInfo(sel[i])); else o2.push(info(sel[i], a.detail)); } return o2; }
    case 'tables': {
      if (a.id !== undefined) {
        var it2 = item(a.id), tb = ctor(it2) === 'Table' ? it2 : (it2.tables && it2.tables.length ? it2.tables[0] : (story(a.id).tables.length ? story(a.id).tables[0] : null));
        if (!tb) throw E('not_found', 'No table in ' + a.id);
        var rows = [], lim = a.limit || 100;
        for (var rr = a.offset || 0; rr < tb.rows.length && rows.length < lim; rr++) rows.push(tb.rows[rr].cells.everyItem().contents);
        return { table: tb.id, rows_total: tb.rows.length, cols: tb.columns.length, header: tb.headerRowCount, style: nm(tb.appliedTableStyle), rows: rows };
      }
      list = []; for (i = 0; i < D.stories.length; i++) { var ss = D.stories[i]; for (var t = 0; t < ss.tables.length; t++) { var T = ss.tables[t], fr2 = ss.textContainers.length ? ss.textContainers[0] : null; list.push({ table: T.id, story: ss.id, frame: fr2 ? fr2.id : null, rows: T.rows.length, cols: T.columns.length, first: trunc(T.cells[0].contents, 30) }); } }
      return page2(list, a, 100);
    }
    case 'masters': list = []; for (i = 0; i < D.masterSpreads.length; i++) { var m = D.masterSpreads[i]; list.push({ name: m.name, prefix: m.namePrefix, pages: m.pages.length, items: m.pageItems.length, basedOn: nm(m.baseName ? m.appliedMaster : null) }); } return list;
    case 'presets': { var pdf = [], dps = []; for (i = 0; i < app.pdfExportPresets.length; i++) pdf.push(app.pdfExportPresets[i].name); for (i = 0; i < app.documentPresets.length; i++) dps.push(app.documentPresets[i].name); return { pdf: pdf, document: dps }; }
    case 'issues': return issues(D, a.limit || 50);
  }
  throw E('bad_args', 'Unknown what=' + w, 'document|pages|items|item|text|find|styles|swatches|layers|links|fonts|selection|tables|masters|presets|issues');
}

// ---------- apply ----------
var CREATED = [];
var FIT = { proportional: 'PROPORTIONALLY', fill: 'FILL_PROPORTIONALLY', content: 'CONTENT_TO_FRAME', frame: 'FRAME_TO_CONTENT', center: 'CENTER_CONTENT' };
var TEXT_EXT = /\.(txt|rtf|docx?|xlsx?|csv|tag)$/i;
function addFrame(a, kind) {
  var pg = page(a.page), coll = { text: 'textFrames', rect: 'rectangles', ellipse: 'ovals', polygon: 'polygons', line: 'graphicLines' }[kind];
  if (!coll) throw E('bad_args', 'kind must be text|rect|ellipse|polygon|line');
  var props = {}; if (a.layer) props.itemLayer = layer(a.layer, true);
  var it = pg[coll].add(props.itemLayer ? props.itemLayer : undefined);
  CREATED.push(it);
  var b = pg.bounds;
  if (kind === 'line') {
    it.paths[0].entirePath = [[b[1] + iu(a.x1), b[0] + iu(a.y1)], [b[1] + iu(a.x2), b[0] + iu(a.y2)]];
  } else if (a.points) {
    var pts = []; for (var i = 0; i < a.points.length; i++) pts.push([b[1] + iu(a.points[i][0]), b[0] + iu(a.points[i][1])]);
    it.paths[0].entirePath = pts;
  } else {
    if (!isNum(a.w) || !isNum(a.h)) throw E('bad_args', kind + ' needs x,y,w,h (or points/x1..y2)');
    it.geometricBounds = toGB(pg, a.x || 0, a.y || 0, a.w, a.h);
  }
  return it;
}
function setText(it, a) {
  var tgt = ctor(it) === 'TextFrame' || ctor(it) === 'Story' || ctor(it) === 'Cell' ? it : null;
  if (!tgt) throw E('bad_target', 'Item ' + it.id + ' is ' + ctor(it) + ', not text', 'use a text frame/story id');
  var txt = String(a.text);
  var s = ctor(tgt) === 'Cell' ? tgt : (tgt.parentStory || tgt);
  var mode = a.mode || 'replace', range;
  if (mode === 'append') { var ip = s.insertionPoints[-1]; var st = ip.index; ip.contents = txt; range = s.characters.itemByRange(st, s.characters.length - 1); }
  else if (mode === 'prepend') { s.insertionPoints[0].contents = txt; range = s.characters.itemByRange(0, txt.length - 1); }
  else { s.contents = txt; range = s.texts[0]; }
  if (a.para_style) range.appliedParagraphStyle = styleByKind('paragraph', a.para_style);
  if (a.char_style) range.appliedCharacterStyle = styleByKind('character', a.char_style);
  if (a.text_props) setProps(ctor(range) === 'Characters' ? range.everyItem() : range, a.text_props);
}
function textTarget(a) {
  var s = textOf(item(a.id));
  if (a.match !== undefined) {
    app.findTextPreferences = NothingEnum.NOTHING; app.findGrepPreferences = NothingEnum.NOTHING;
    var res;
    if (a.grep) { app.findGrepPreferences.findWhat = a.match; res = s.findGrep(); } else { app.findTextPreferences.findWhat = a.match; res = s.findText(); }
    app.findTextPreferences = NothingEnum.NOTHING; app.findGrepPreferences = NothingEnum.NOTHING;
    if (!res.length) throw E('not_found', 'No text matches "' + a.match + '" in ' + a.id);
    return res;
  }
  if (a.paragraphs) { var p = a.paragraphs, ps = s.paragraphs; var st = p[0], en = p.length > 1 ? p[1] : p[0]; if (en >= ps.length) en = ps.length - 1; return [ps.itemByRange(st, en)]; }
  if (a.chars) return [s.characters.itemByRange(a.chars[0], a.chars[1])];
  return [s];
}
function ensureStyle(kind, name, basedOn, props) {
  var s = styleByKind(kind, name, false), created = false;
  if (!s) { var coll = { paragraph: 'paragraphStyles', character: 'characterStyles', object: 'objectStyles', table: 'tableStyles', cell: 'cellStyles' }[kind]; s = D[coll].add({ name: name }); created = true; }
  if (basedOn) s.basedOn = styleByKind(kind, basedOn);
  setProps(s, props, kind);
  return { name: s.name, created: created };
}
function cleanupCreated() { for (var i = CREATED.length - 1; i >= 0; i--) { try { if (valid(CREATED[i])) CREATED[i].remove(); } catch (e) {} } }

// Live area of a page as [x, y, w, h] in points, page-relative (handles left-hand pages of facing docs).
function marginBox(pg) {
  var b = pg.bounds, mp = pg.marginPreferences, W = b[3] - b[1], H = b[2] - b[0], left = mp.left, right = mp.right;
  try { if (pg.side === PageSideOptions.LEFT_HAND) { left = mp.right; right = mp.left; } } catch (e) {}
  return [left, mp.top, W - left - right, H - mp.top - mp.bottom];
}
function fname(f) { return decodeURI(f.name); }
var IMG_RE = /\.(jpe?g|png|tiff?|psd|pdf|ai|eps|gif|bmp)$/i;
function filesFrom(a, re) {
  var out = [], i, rx = a.pattern ? new RegExp(a.pattern, 'i') : re;
  if (a.files) for (i = 0; i < a.files.length; i++) { var f = File(a.files[i]); if (!f.exists) throw E('not_found', 'File not found: ' + a.files[i]); out.push(f); }
  if (a.folder) { var fo = Folder(a.folder); if (!fo.exists) throw E('not_found', 'Folder not found: ' + a.folder); walk(fo, 0); }
  function walk(fo, depth) {
    var l = fo.getFiles(); l.sort(function (x, y) { var p = lower(fname(x)), p2 = lower(fname(y)); return p < p2 ? -1 : p > p2 ? 1 : 0; });
    for (var j = 0; j < l.length; j++) { if (l[j] instanceof Folder) { if (a.recursive && depth < 8) walk(l[j], depth + 1); } else if (rx.test(fname(l[j]))) out.push(l[j]); }
  }
  return out;
}
function readCsv(path, delim, enc) {
  var f = File(path); if (!f.exists) throw E('not_found', 'CSV not found: ' + path);
  function rd(e) { f.encoding = e; f.open('r'); var t = f.read(); f.close(); return t; }
  var s = rd(enc || 'UTF-8');
  // Excel on German Windows writes ANSI; ExtendScript returns '' (or U+FFFD) for invalid UTF-8.
  if (!enc && (!s || s.indexOf('\ufffd') >= 0) && f.length > 0) s = rd('CP1252');
  s = s || '';
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  if (!delim) {
    var first = s.split(/\r\n|\r|\n/)[0], best = ';', n = first.split(';').length;
    if (first.split('\t').length > n) { best = '\t'; n = first.split('\t').length; }
    if (first.split(',').length > n) best = ',';
    delim = best;
  }
  var rows = [], row = [], fld = '', inq = false, ch;
  for (var i = 0; i < s.length; i++) {
    ch = s.charAt(i);
    if (inq) { if (ch === '"') { if (s.charAt(i + 1) === '"') { fld += '"'; i++; } else inq = false; } else fld += ch; }
    else if (ch === '"') inq = true;
    else if (ch === delim) { row.push(fld); fld = ''; }
    else if (ch === '\r' || ch === '\n') { if (ch === '\r' && s.charAt(i + 1) === '\n') i++; row.push(fld); rows.push(row); row = []; fld = ''; }
    else fld += ch;
  }
  if (fld !== '' || row.length) { row.push(fld); rows.push(row); }
  return rows;
}
function moveBy(it, dx, dy) { if (dx || dy) it.move(undefined, [dx, dy]); }
function escGrep(t) { return t.replace(/([\\^$.|?*+()\[\]{}~])/g, '\\$1'); }

var OPS = {
  create: function (a) {
    var it = addFrame(a, a.kind || 'rect');
    if (a.text !== undefined && ctor(it) === 'TextFrame') setText(it, a);
    if (a.name) it.name = a.name;
    if (a.label) it.label = a.label;
    if (a.props) setProps(it, a.props, 'object');
    if (a.fit_text && ctor(it) === 'TextFrame') it.fit(FitOptions.FRAME_TO_CONTENT);
    return { id: it.id, type: ctor(it) };
  },
  place: function (a) {
    var f = File(a.file); if (!f.exists) throw E('not_found', 'File not found: ' + a.file);
    var frame, placed;
    if (a.into !== undefined) frame = item(a.into);
    else if (isNum(a.w) && isNum(a.h)) frame = addFrame(a, TEXT_EXT.test(f.name) ? 'text' : 'rect');
    var tip = app.textImportPreferences, oldCs = null;
    if (/\.(txt|csv)$/i.test(f.name)) { try { oldCs = tip.characterSet; tip.characterSet = TextImportCharacterSet[a.charset || 'UTF8']; } catch (e0) {} }
    try {
      if (frame) { placed = frame.place(f, false); }
      else { var pg = page(a.page), b = pg.bounds; placed = pg.place(f, [b[1] + iu(a.x || 0), b[0] + iu(a.y || 0)], a.layer ? layer(a.layer, true) : undefined, false, !!a.autoflow); }
    } finally { if (oldCs !== null) try { tip.characterSet = oldCs; } catch (e1) {} }
    var p0 = placed && placed.length ? placed[0] : placed;
    var fr = frame || (ctor(p0) === 'Story' ? p0.textContainers[0] : p0.parent);
    if (!frame) CREATED.push(fr);
    if (a.fit && FitOptions[FIT[a.fit] || a.fit] && ctor(fr) !== 'TextFrame') fr.fit(FitOptions[FIT[a.fit] || a.fit]);
    if (a.name) fr.name = a.name;
    if (a.props) setProps(fr, a.props, 'object');
    return { id: fr.id, type: ctor(fr), content: ctor(p0) };
  },
  set: function (a) {
    var its = items(a.ids || a.id), out = [];
    for (var i = 0; i < its.length; i++) {
      var it = its[i];
      applyBox(it, a);
      if (isNum(a.rotate)) it.rotationAngle = a.rotate;
      if (a.text !== undefined) setText(it, a);
      if (a.name !== undefined) it.name = a.name;
      if (a.label !== undefined) it.label = a.label;
      if (a.props) setProps(it, a.props, 'object');
      out.push(it.id);
    }
    return { ids: out };
  },
  text: function (a) {
    var t = textTarget(a), n = 0;
    for (var i = 0; i < t.length; i++) {
      var x = t[i];
      if (a.para_style) x.appliedParagraphStyle = styleByKind('paragraph', a.para_style);
      if (a.char_style) x.appliedCharacterStyle = styleByKind('character', a.char_style);
      if (a.clear_overrides) x.clearOverrides();
      if (a.props) setProps(x, a.props);
      if (a.replace !== undefined) x.contents = a.replace;
      n++;
    }
    return { ranges: n };
  },
  replace: function (a) {
    var res = findIn(a), n = res.length;
    if (a.dry_run) { var hits = []; for (var i = 0; i < res.length && i < 20; i++) hits.push(hitInfo(res[i], true)); return { count: n, hits: hits }; }
    for (var j = res.length - 1; j >= 0; j--) {
      var t = res[j];
      if (a.replace !== undefined) {
        if (a.grep) { app.findGrepPreferences.findWhat = a.find; app.changeGrepPreferences = NothingEnum.NOTHING; app.changeGrepPreferences.changeTo = a.replace; t.changeGrep(); }
        else t.contents = a.replace;
      }
      if (a.change_props) { var rr = t; if (a.replace !== undefined && !a.grep) rr = t; setProps(rr, a.change_props); }
    }
    app.findGrepPreferences = NothingEnum.NOTHING; app.findTextPreferences = NothingEnum.NOTHING; app.changeGrepPreferences = NothingEnum.NOTHING;
    return { count: n };
  },
  'delete': function (a) { var its = items(a.ids || a.id), n = 0; for (var i = 0; i < its.length; i++) { its[i].remove(); n++; } return { deleted: n }; },
  duplicate: function (a) {
    var src = item(a.id), out = [], n = a.count || 1;
    for (var i = 1; i <= n; i++) {
      var dup = a.page !== undefined ? src.duplicate(page(a.page)) : src.duplicate();
      CREATED.push(dup);
      dup.move(undefined, [iu(a.dx || 0) * i, iu(a.dy || 0) * i]);
      out.push(dup.id);
    }
    return { ids: out };
  },
  group: function (a) { var its = items(a.ids); var g = its[0].parent.groups.add(its); CREATED.push(g); if (a.name) g.name = a.name; return { id: g.id }; },
  ungroup: function (a) { var g = item(a.id); var kids = g.pageItems.everyItem().id; g.ungroup(); return { ids: kids }; },
  arrange: function (a) {
    var its = items(a.ids || a.id), m = { front: 'bringToFront', back: 'sendToBack', forward: 'bringForward', backward: 'sendBackward' }[a.to || 'front'];
    for (var i = 0; i < its.length; i++) its[i][m]();
    return { ids: a.ids || [a.id] };
  },
  fit: function (a) { var its = items(a.ids || a.id); var fo = FitOptions[FIT[a.mode || 'proportional'] || a.mode]; for (var i = 0; i < its.length; i++) its[i].fit(fo); return { fitted: its.length }; },
  pages: function (a) {
    var act = a.action || 'add';
    if (act === 'add') {
      var ref = a.after !== undefined ? page(a.after) : D.pages[-1], out = [];
      for (var i = 0; i < (a.count || 1); i++) { var p = D.pages.add(LocationOptions.AFTER, ref); if (a.master !== undefined) p.appliedMaster = master(a.master); ref = p; out.push(pageNo(p)); }
      return { added: out, total: D.pages.length };
    }
    var pgs = pageList(a.pages);
    if (act === 'delete') { if (pgs.length >= D.pages.length) throw E('bad_args', 'Cannot delete every page'); for (var j = pgs.length - 1; j >= 0; j--) pgs[j].remove(); return { deleted: pgs.length, total: D.pages.length }; }
    if (act === 'master') { var m = master(a.master); for (j = 0; j < pgs.length; j++) pgs[j].appliedMaster = m; return { pages: pgs.length }; }
    if (act === 'move') { var tgt = page(a.to); pgs[0].move(a.before ? LocationOptions.BEFORE : LocationOptions.AFTER, tgt); return { page: pageNo(pgs[0]) }; }
    if (act === 'duplicate') { var d2 = pgs[0].duplicate(LocationOptions.AFTER, pgs[pgs.length - 1]); return { page: pageNo(d2) }; }
    if (act === 'set') { for (j = 0; j < pgs.length; j++) { if (a.margins) { var mg = a.margins instanceof Array ? a.margins : [a.margins, a.margins, a.margins, a.margins]; setProps(pgs[j].marginPreferences, { top: iu(mg[0]), right: iu(mg[1]), bottom: iu(mg[2]), left: iu(mg[3]) }); } if (a.props) setProps(pgs[j], a.props); } return { pages: pgs.length }; }
    throw E('bad_args', 'pages action must be add|delete|master|move|duplicate|set');
  },
  layer: function (a) {
    var l = layer(a.name, !a.delete);
    if (a.delete) { l.remove(); return { deleted: a.name }; }
    if (a.rename) l.name = a.rename;
    if (a.props) setProps(l, a.props);
    if (a.active) D.activeLayer = l;
    return { name: l.name };
  },
  style: function (a) { return ensureStyle(a.kind || 'paragraph', a.name, a.based_on, a.props); },
  swatch: function (a) {
    var c = findStyle(D.swatches, a.name), created = false;
    if (!c) { c = D.colors.add({ name: a.name }); created = true; }
    var sp = { cmyk: 'CMYK', rgb: 'RGB', lab: 'LAB' }[lower(a.space || 'cmyk')];
    c.space = ColorSpace[sp];
    c.model = a.spot ? ColorModel.SPOT : ColorModel.PROCESS;
    if (a.values) c.colorValue = a.values;
    return { name: c.name, created: created };
  },
  table: function (a) {
    var fr = a.id !== undefined ? item(a.id) : addFrame(a, 'text');
    if (ctor(fr) !== 'TextFrame') throw E('bad_target', 'table needs a text frame id or page,x,y,w,h');
    var data = a.csv ? readCsv(a.csv, a.delimiter, a.encoding) : (a.data || []), mc = 0;
    for (var q0 = 0; q0 < data.length; q0++) if (data[q0].length > mc) mc = data[q0].length;
    var rows = a.rows || data.length || 2, cols = a.cols || mc || 2;
    var hdr = a.header_rows || 0;
    var t = fr.parentStory.insertionPoints[-1].tables.add({ bodyRowCount: rows - hdr, columnCount: cols, headerRowCount: hdr });
    if (isNum(fr.geometricBounds[3])) { try { var w = fr.geometricBounds[3] - fr.geometricBounds[1] - 0.01; t.width = w; } catch (e) {} }
    if (data.length) { var flat = []; for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) flat.push(data[r] && data[r][c] !== undefined && data[r][c] !== null ? String(data[r][c]) : ''); t.contents = flat; }
    if (a.style) t.appliedTableStyle = styleByKind('table', a.style);
    if (a.props) setProps(t, a.props);
    if (a.cell_props) setProps(t.cells.everyItem(), a.cell_props);
    return { frame: fr.id, table: t.id, rows: t.rows.length, cols: t.columns.length };
  },
  cells: function (a) {
    var it = item(a.id), t = ctor(it) === 'Table' ? it : (it.tables && it.tables.length ? it.tables[0] : story(a.id).tables[0]);
    if (!valid(t)) throw E('not_found', 'No table at ' + a.id);
    var r0 = a.row || 0, c0 = a.col || 0, n = 0, data = a.data || [];
    while (t.rows.length < r0 + data.length) t.rows.add(LocationOptions.AT_END);
    for (var r = 0; r < data.length; r++) for (var c = 0; c < data[r].length; c++) { if (data[r][c] === null || data[r][c] === undefined) continue; t.rows[r0 + r].cells[c0 + c].contents = String(data[r][c]); n++; }
    if (a.cell_props) { var rg = a.range || [r0, c0, r0 + Math.max(data.length, 1) - 1, c0 + Math.max(data[0] ? data[0].length : 1, 1) - 1];
      for (r = rg[0]; r <= rg[2]; r++) for (c = rg[1]; c <= rg[3]; c++) setProps(t.rows[r].cells[c], a.cell_props); }
    if (a.props) setProps(t, a.props);
    return { table: t.id, cells: n, rows: t.rows.length };
  },
  relink: function (a) {
    if (a.folder) {
      var idx = {}, fl = filesFrom({ folder: a.folder, recursive: a.recursive !== false }, /./), i, n = 0, miss = [];
      for (i = 0; i < fl.length; i++) { var key = lower(fname(fl[i])); if (!idx[key]) idx[key] = fl[i]; }
      var lks = D.links.everyItem().getElements();
      for (i = 0; i < lks.length; i++) {
        if (!a.all && lks[i].status !== LinkStatus.LINK_MISSING) continue;
        var hit = idx[lower(lks[i].name)];
        if (hit) { lks[i].relink(hit); n++; } else miss.push(lks[i].name);
      }
      return { relinked: n, still_missing: miss, searched: fl.length };
    }
    var l, f = a.file ? File(a.file) : null;
    if (a.link !== undefined) { l = isNum(a.link) ? D.links.itemByID(a.link) : D.links.itemByName(a.link); if (!valid(l)) throw E('not_found', 'Link not found: ' + a.link); }
    if (f) { if (!f.exists) throw E('not_found', 'File not found: ' + a.file); l.relink(f); return { link: l.name, status: enumName('LinkStatus', l.status) }; }
    var n = 0, ls = l ? [l] : D.links.everyItem().getElements();
    for (var i = 0; i < ls.length; i++) if (ls[i].status === LinkStatus.LINK_OUT_OF_DATE) { ls[i].update(); n++; }
    return { updated: n };
  },
  fill: function (a) {
    // Placeholder fill: map {"{{Projekt}}": "Neubau"} and/or data {Projekt: "Neubau"} with token "{{%s}}".
    var map = {}, k, j, counts = {}, total = 0, tok = a.token || '{{%s}}';
    if (a.map) for (k in a.map) if (a.map.hasOwnProperty(k)) map[k] = a.map[k];
    if (a.data) for (k in a.data) if (a.data.hasOwnProperty(k)) map[tok.replace('%s', k)] = a.data[k];
    var scope = a.id !== undefined ? story(a.id) : D, o = app.findChangeTextOptions;
    app.findTextPreferences = NothingEnum.NOTHING;
    o.caseSensitive = true; o.wholeWord = false; o.includeMasterPages = a.masters !== false; o.includeHiddenLayers = true;
    o.includeLockedLayersForFind = true; o.includeLockedStoriesForFind = true; o.includeFootnotes = true;
    for (k in map) {
      if (!map.hasOwnProperty(k)) continue;
      app.findTextPreferences.findWhat = k;
      var res = scope.findText(), v = map[k] === null || map[k] === undefined ? '' : String(map[k]);
      for (j = res.length - 1; j >= 0; j--) res[j].contents = v;   // contents, not changeTo: no ^ escaping, no length limit
      counts[k] = res.length; total += res.length;
    }
    app.findTextPreferences = NothingEnum.NOTHING;
    var left = [], parts = tok.split('%s');
    if (parts.length === 2 && parts[0]) {
      app.findGrepPreferences = NothingEnum.NOTHING; app.findChangeGrepOptions.includeMasterPages = a.masters !== false;
      app.findGrepPreferences.findWhat = escGrep(parts[0]) + '[^\\r]{1,60}?' + escGrep(parts[1]);
      var lf = scope.findGrep(), seen = {}; app.findGrepPreferences = NothingEnum.NOTHING;
      for (j = 0; j < lf.length && left.length < 50; j++) { var c = lf[j].contents; if (!seen[c]) { seen[c] = 1; left.push(c); } }
    }
    return { total: total, counts: counts, unfilled: left };
  },
  grid: function (a) {
    var files = filesFrom(a, IMG_RE), i;
    if (!files.length) throw E('not_found', 'No image files to place', 'pass files[] or folder (+pattern)');
    var pg = page(a.page), pb = pg.bounds, area = a.area ? [iu(a.area[0]), iu(a.area[1]), iu(a.area[2]), iu(a.area[3])] : marginBox(pg);
    var n = files.length;
    var cols = a.cols || (a.rows ? Math.ceil(n / a.rows) : Math.max(1, Math.round(Math.sqrt(n * area[2] / area[3] / (a.ratio || 1.5)))));
    var rows = a.rows || Math.ceil(n / cols);
    var g = iu(isNum(a.gutter) ? a.gutter : 5), ch = a.captions ? iu(a.caption_h || 6) : 0;
    var cw = (area[2] - (cols - 1) * g) / cols, cellH = (area[3] - (rows - 1) * g) / rows, ih = cellH - ch;
    if (cw <= 0 || ih <= 0) throw E('bad_args', 'Grid cells too small: ' + ou(cw) + ' x ' + ou(ih), 'fewer rows/cols, smaller gutter or larger area');
    var lay = a.layer ? layer(a.layer, true) : undefined, ids = [], caps = [], fo = FitOptions[FIT[a.fit || 'fill'] || a.fit];
    for (i = 0; i < n && i < rows * cols; i++) {
      var r = Math.floor(i / cols), c = i % cols, x0 = pb[1] + area[0] + c * (cw + g), y0 = pb[0] + area[1] + r * (cellH + g);
      var rc = pg.rectangles.add(lay); CREATED.push(rc);
      rc.geometricBounds = [y0, x0, y0 + ih, x0 + cw];
      rc.strokeWeight = 0;
      rc.place(files[i], false);
      if (fo) rc.fit(fo);
      if (a.props) setProps(rc, a.props, 'object');
      ids.push(rc.id);
      if (a.captions) {
        var tf = pg.textFrames.add(lay); CREATED.push(tf);
        tf.geometricBounds = [y0 + ih + iu(1), x0, y0 + cellH, x0 + cw];
        tf.contents = a.captions instanceof Array ? String(a.captions[i] || '') : fname(files[i]).replace(/\.[^.]+$/, '');
        if (a.caption_style) tf.parentStory.texts[0].appliedParagraphStyle = styleByKind('paragraph', a.caption_style);
        caps.push(tf.id);
      }
    }
    var o = { ids: ids, rows: rows, cols: cols, cell: [ou(cw), ou(ih)] };
    if (caps.length) o.captions = caps;
    if (n > rows * cols) o.skipped = n - rows * cols;
    return o;
  },
  thread: function (a) {
    var fr = items(a.ids), i;
    for (i = 0; i < fr.length; i++) if (ctor(fr[i]) !== 'TextFrame') throw E('bad_target', 'thread needs text frames; ' + fr[i].id + ' is ' + ctor(fr[i]));
    for (i = 0; i < fr.length - 1; i++) fr[i].nextTextFrame = fr[i + 1];
    return { story: fr[0].parentStory.id, frames: fr.length, overset: fr[0].parentStory.overflows };
  },
  flow: function (a) {
    // Add pages + threaded frames (margin area, page's columns) until the story fits.
    var s = story(a.id), max = a.max_pages || 50, added = 0, frames = [], tc = s.textContainers, last = tc[tc.length - 1];
    s.recompose();
    while (s.overflows && added < max) {
      var lp = null; try { lp = last.parentPage; } catch (e) {}
      var np = D.pages.add(LocationOptions.AFTER, lp || D.pages[-1]); added++; CREATED.push(np);
      if (a.master !== undefined) np.appliedMaster = master(a.master);
      var mb = marginBox(np), b = np.bounds, tf = np.textFrames.add();
      tf.geometricBounds = [b[0] + mb[1], b[1] + mb[0], b[0] + mb[1] + mb[3], b[1] + mb[0] + mb[2]];
      try { tf.itemLayer = last.itemLayer; } catch (e1) {}
      try { tf.textFramePreferences.textColumnCount = np.marginPreferences.columnCount; tf.textFramePreferences.textColumnGutter = np.marginPreferences.columnGutter; } catch (e2) {}
      last.nextTextFrame = tf; last = tf; frames.push(tf.id);
      s.recompose();
    }
    return { pages_added: added, frames: frames, overset: s.overflows, total_pages: D.pages.length };
  },
  align: function (a) {
    var its = items(a.ids || a.id), i, ref, rk = a.ref || (its.length === 1 ? 'margins' : 'selection');
    if (rk === 'page' || rk === 'margins') {
      var pg = null; try { pg = its[0].parentPage; } catch (e) {}
      pg = pg || page(null);
      var b = pg.bounds; ref = b;
      if (rk === 'margins') { var m = marginBox(pg); ref = [b[0] + m[1], b[1] + m[0], b[0] + m[1] + m[3], b[1] + m[0] + m[2]]; }
    } else if (rk === 'selection') {
      ref = its[0].geometricBounds.slice(0);
      for (i = 1; i < its.length; i++) { var q1 = its[i].geometricBounds; ref = [Math.min(ref[0], q1[0]), Math.min(ref[1], q1[1]), Math.max(ref[2], q1[2]), Math.max(ref[3], q1[3])]; }
    } else ref = item(rk).geometricBounds;
    var to = a.to instanceof Array ? a.to : (a.to === 'center' ? ['hcenter', 'vcenter'] : [a.to || 'left']);
    for (i = 0; i < its.length; i++) {
      var gb = its[i].geometricBounds, dx = 0, dy = 0;
      for (var t = 0; t < to.length; t++) {
        var w = to[t];
        if (w === 'left') dx = ref[1] - gb[1]; else if (w === 'right') dx = ref[3] - gb[3]; else if (w === 'hcenter') dx = (ref[1] + ref[3] - gb[1] - gb[3]) / 2;
        else if (w === 'top') dy = ref[0] - gb[0]; else if (w === 'bottom') dy = ref[2] - gb[2]; else if (w === 'vcenter') dy = (ref[0] + ref[2] - gb[0] - gb[2]) / 2;
        else throw E('bad_args', 'to must be left|right|hcenter|top|bottom|vcenter|center');
      }
      moveBy(its[i], dx, dy);
    }
    return { aligned: its.length, ref: rk };
  },
  distribute: function (a) {
    var its = items(a.ids), h = (a.axis || 'h') === 'h', s0 = h ? 1 : 0, e0 = h ? 3 : 2, i, gap;
    if (its.length < 2) throw E('bad_args', 'distribute needs 2+ ids');
    its.sort(function (x, y) { return x.geometricBounds[s0] - y.geometricBounds[s0]; });
    var gbs = []; for (i = 0; i < its.length; i++) gbs.push(its[i].geometricBounds);
    if (isNum(a.gap)) gap = iu(a.gap);
    else { var sum = 0; for (i = 0; i < gbs.length; i++) sum += gbs[i][e0] - gbs[i][s0]; gap = (gbs[gbs.length - 1][e0] - gbs[0][s0] - sum) / (its.length - 1); }
    var pos = gbs[0][e0];
    for (i = 1; i < its.length; i++) { var d = pos + gap - gbs[i][s0]; moveBy(its[i], h ? d : 0, h ? 0 : d); pos = gbs[i][e0] + d; }
    return { distributed: its.length, gap: ou(gap) };
  },
  select: function (a) { var its = a.ids && a.ids.length ? items(a.ids) : []; if (its.length) { app.select(its); } else app.select(NothingEnum.NOTHING); return { selected: its.length }; },
  document: function (a) {
    var dp = D.documentPreferences;
    var map = { w: 'pageWidth', h: 'pageHeight', facing: 'facingPages' }, p = {};
    for (var k in a) if (map[k]) p[map[k]] = k === 'facing' ? a[k] : iu(a[k]);
    if (a.bleed !== undefined) { var bl = a.bleed instanceof Array ? a.bleed : [a.bleed, a.bleed, a.bleed, a.bleed]; p.documentBleedUniformSize = false; p.documentBleedTopOffset = iu(bl[0]); p.documentBleedOutsideOrRightOffset = iu(bl[1]); p.documentBleedBottomOffset = iu(bl[2]); p.documentBleedInsideOrLeftOffset = iu(bl[3]); }
    setProps(dp, p); if (a.props) setProps(D, a.props);
    return { w: dp.pageWidth, h: dp.pageHeight };
  }
};

var PENDING = { pages: 0 };   // things created earlier in the same batch: 'item:Title', 'paragraph:Body', added pages
function precheck(op, a) {
  // Resolve references up front so most mistakes fail before anything changes.
  function it(id) { if (!PENDING['item:' + id]) item(id); }
  function st(kind, n) { if (!PENDING[kind + ':' + n]) styleByKind(kind, n); }
  if (a.id !== undefined && op !== 'pages' && op !== 'layer' && op !== 'style' && op !== 'relink') it(a.id);
  if (a.csv && !File(a.csv).exists) throw E('not_found', 'CSV not found: ' + a.csv);
  if (a.folder && !Folder(a.folder).exists) throw E('not_found', 'Folder not found: ' + a.folder);
  if (op === 'flow') PENDING.pages += a.max_pages || 50;
  if (a.ids) for (var i = 0; i < a.ids.length; i++) it(a.ids[i]);
  if (a.into !== undefined) it(a.into);
  if (a.para_style) st('paragraph', a.para_style);
  if (a.char_style) st('character', a.char_style);
  if (op === 'style') PENDING[(a.kind || 'paragraph') + ':' + a.name] = 1;
  if (a.name && (op === 'create' || op === 'place' || op === 'group' || op === 'set')) PENDING['item:' + a.name] = 1;
  if (op === 'pages' && (a.action || 'add') === 'add') PENDING.pages += a.count || 1;
  if (a.file && op === 'place' && !File(a.file).exists) throw E('not_found', 'File not found: ' + a.file);
  if (a.page !== undefined && op !== 'pages' && !(isNum(a.page) && a.page > D.pages.length && a.page <= D.pages.length + PENDING.pages)) page(a.page);
  if (a.pages !== undefined && op === 'pages') pageList(a.pages);
}

function apply(a) {
  var ops = a.ops || [], res = [], i;
  CREATED = []; PENDING = { pages: 0 };
  if (!(ops instanceof Array) || !ops.length) throw E('bad_args', 'ops must be a non-empty array');
  for (i = 0; i < ops.length; i++) {
    var o = ops[i]; if (!OPS[o.op]) throw E('bad_args', 'ops[' + i + ']: unknown op "' + o.op + '"', 'ops: ' + keys(OPS).join('|'));
    try { precheck(o.op, o); } catch (e) { e.message = 'ops[' + i + '] ' + o.op + ': ' + e.message; e.op = i; throw e; }
  }
  // typographic_quotes:false keeps " and ' literal in text set by this batch (InDesign converts them by default).
  var tpref = D.textPreferences, oldQ = null;
  if (a.typographic_quotes !== undefined) { oldQ = tpref.typographersQuotes; tpref.typographersQuotes = !!a.typographic_quotes; }
  try {
    for (i = 0; i < ops.length; i++) {
      try { var r = OPS[ops[i].op](ops[i]); r.op = ops[i].op; res.push(r); }
      catch (e2) {
        var keep = !!a.keep_partial; if (!keep) cleanupCreated();
        var err = E(e2.code || 'op_failed', 'ops[' + i + '] ' + ops[i].op + ': ' + e2.message + (!e2.code && e2.line ? ' (runtime line ' + e2.line + ')' : ''), e2.next || 'fix this op and resend the batch');
        err.op = i; err.done = res;
        err.rolled_back = i === 0 && !CREATED.length ? 'no items created; ops[0] may be partially applied (check with indesign_read)' : (keep ? 'none (keep_partial)' :
          'NOT atomic: items created by this batch were removed, but other edits from ops[0..' + (i - 1) + '] (and any partial edit by ops[' + i + ']) remain; scripted undo is unavailable in CS6, so revert them with explicit ops');
        throw err;
      }
    }
  } finally { if (oldQ !== null) try { tpref.typographersQuotes = oldQ; } catch (e3) {} }
  return { results: res, doc: D.name };
}
function keys(o) { var a = []; for (var k in o) if (o.hasOwnProperty(k)) a.push(k); return a; }

// ---------- document tool ----------
function exportFile(a) {
  var fmt = lower(a.format || 'pdf'), f = File(a.path), pr, i;
  if (!a.path) throw E('bad_args', 'path is required');
  if (f.exists && a.overwrite === false) throw E('exists', 'File exists: ' + a.path);
  if (!f.parent.exists) f.parent.create();
  var range = a.pages ? String(a.pages instanceof Array ? a.pages.join(',') : a.pages) : null;
  var abs = range ? range.replace(/(\d+)/g, '+$1') : null;   // "+N" = absolute page position
  if (fmt === 'pdf') {
    var preset = a.preset ? app.pdfExportPresets.itemByName(a.preset) : null;
    if (a.preset && !valid(preset)) { var names = []; for (i = 0; i < app.pdfExportPresets.length; i++) names.push(app.pdfExportPresets[i].name); throw E('not_found', 'PDF preset not found: ' + a.preset, 'presets: ' + names.join(', ')); }
    var pp = app.pdfExportPreferences, saved = pp.properties, k;
    try {
      // Preset settings are copied into the export prefs so per-export overrides apply on top; user prefs are restored after.
      if (preset) { var pr0 = preset.properties; for (k in pr0) { if (k === 'name' || k === 'parent' || k === 'id' || k === 'index') continue; try { pp[k] = pr0[k]; } catch (e0) {} } }
      pp.pageRange = abs || PageRange.ALL_PAGES;
      if (a.spreads !== undefined) pp.exportReaderSpreads = !!a.spreads;
      if (a.crop_marks !== undefined) pp.cropMarks = !!a.crop_marks;
      if (a.bleed !== undefined) pp.useDocumentBleedWithPDF = !!a.bleed;
      if (a.props) setProps(pp, a.props);
      D.exportFile(ExportFormat.PDF_TYPE, f, false);
    } finally { for (k in saved) { try { pp[k] = saved[k]; } catch (e1) {} } }
  } else if (fmt === 'png' || fmt === 'jpg' || fmt === 'jpeg') {
    var png = fmt === 'png', ep = png ? app.pngExportPreferences : app.jpegExportPreferences;
    if (png) { ep.pngExportRange = abs ? PNGExportRangeEnum.EXPORT_RANGE : PNGExportRangeEnum.EXPORT_ALL; ep.transparentBackground = !!a.transparent; }
    else { ep.jpegExportRange = abs ? ExportRangeOrAllPages.EXPORT_RANGE : ExportRangeOrAllPages.EXPORT_ALL; ep.jpegQuality = JPEGOptionsQuality[(a.quality || 'high').toUpperCase()]; }
    if (abs) ep.pageString = abs;
    ep.exportResolution = a.resolution || 150;
    ep.exportingSpread = !!a.spreads;
    try { ep.useDocumentBleeds = !!a.bleed; } catch (e) {}
    if (a.id !== undefined) item(a.id).exportFile(png ? ExportFormat.PNG_FORMAT : ExportFormat.JPG, f);
    else D.exportFile(png ? ExportFormat.PNG_FORMAT : ExportFormat.JPG, f, false);
  } else if (fmt === 'idml') D.exportFile(ExportFormat.INDESIGN_MARKUP, f);
  else if (fmt === 'eps') { if (abs) app.epsExportPreferences.pageRange = abs; D.exportFile(ExportFormat.EPS_TYPE, f); }
  else if (fmt === 'rtf' || fmt === 'txt') { var s = story(a.id); s.exportFile(fmt === 'rtf' ? ExportFormat.RTF : ExportFormat.TEXT_TYPE, f); }
  else throw E('bad_args', 'format must be pdf|png|jpg|idml|eps|rtf|txt');
  return { path: f.fsName, format: fmt };
}
function documentAction(a) {
  var act = a.action, d;
  switch (act) {
    case 'new': {
      var preset = a.preset ? app.documentPresets.itemByName(a.preset) : undefined;
      if (a.preset && !valid(preset)) throw E('not_found', 'Document preset not found: ' + a.preset);
      d = app.documents.add(a.window !== false, preset);
      D = d;
      var dp = d.documentPreferences;
      if (a.facing !== undefined) dp.facingPages = !!a.facing;
      if (isNum(a.w)) dp.pageWidth = iu(a.w); if (isNum(a.h)) dp.pageHeight = iu(a.h);
      if (a.pages) dp.pagesPerDocument = a.pages;
      if (a.bleed !== undefined) { dp.documentBleedUniformSize = true; dp.documentBleedTopOffset = iu(a.bleed); }
      var mg = a.margins !== undefined ? (a.margins instanceof Array ? a.margins : [a.margins, a.margins, a.margins, a.margins]) : null;
      if (mg) mg = [iu(mg[0]), iu(mg[1]), iu(mg[2]), iu(mg[3])];
      for (var m = 0; m < d.masterSpreads.length; m++) for (var p = 0; p < d.masterSpreads[m].pages.length; p++) {
        var mp = d.masterSpreads[m].pages[p].marginPreferences;
        if (mg) { mp.top = mg[0]; mp.right = mg[1]; mp.bottom = mg[2]; mp.left = mg[3]; }
        if (a.columns) mp.columnCount = a.columns; if (isNum(a.gutter)) mp.columnGutter = iu(a.gutter);
      }
      for (p = 0; p < d.pages.length; p++) { var pm = d.pages[p].marginPreferences; if (mg) { pm.top = mg[0]; pm.right = mg[1]; pm.bottom = mg[2]; pm.left = mg[3]; } if (a.columns) pm.columnCount = a.columns; if (isNum(a.gutter)) pm.columnGutter = iu(a.gutter); }
      if (a.path) d = d.save(File(a.path));
      return docInfo(d);
    }
    case 'open': {
      var f = File(a.path); if (!f.exists) throw E('not_found', 'File not found: ' + a.path);
      d = app.open(f, a.window !== false);
      if (d instanceof Array) d = d[0];
      D = d; return docInfo(d);
    }
  }
  if (act === 'batch') return batch(a);
  D = doc(a.doc);
  switch (act) {
    case 'info': return docInfo(D);
    case 'activate': app.activeDocument = D; return { active: D.name };
    case 'save': { if (a.path) { var nd = D.save(File(a.path)); return { saved: nd.fullName.fsName }; } if (!D.saved) throw E('needs_path', 'Untitled document needs a path', 'pass path=...indd'); D.save(); return { saved: D.fullName.fsName }; }
    case 'save_copy': D.saveACopy(File(a.path)); return { saved_copy: File(a.path).fsName };
    case 'close': {
      if (D.modified && a.save === undefined) throw E('unsaved_changes', D.name + ' has unsaved changes', 'pass save=true or save=false');
      var n = D.name; D.close(a.save ? SaveOptions.YES : SaveOptions.NO); return { closed: n };
    }
    case 'export': return exportFile(a);
    case 'package': {
      var fo = Folder(a.path); if (!fo.exists) fo.create();
      D.packageForPrint(fo, a.fonts !== false, a.links !== false, false, true, !!a.hidden_layers, true, !!a.report, !!a.idml, !!a.pdf);
      return { packaged: fo.fsName };
    }
    case 'undo': case 'redo': { var c = 0, k = a.steps || 1; try { for (; c < k; c++) D[act](); } catch (e) { if (!c) throw E('cannot_' + act, 'Nothing to ' + act + ' (InDesign: ' + e.message + ')'); } return { steps: c }; }
    case 'preflight': return issues(D, a.limit || 100);
    case 'zoom': {
      var w = app.activeWindow;
      if (a.page !== undefined) w.activePage = page(a.page);
      if (a.id !== undefined) { app.select(item(a.id)); w.zoom(ZoomOptions.FIT_PAGE); }
      if (a.fit) w.zoom(ZoomOptions[{ page: 'FIT_PAGE', spread: 'FIT_SPREAD', actual: 'ACTUAL_SIZE' }[a.fit] || 'FIT_PAGE']);
      if (isNum(a.percent)) w.zoomPercentage = a.percent;
      return { page: pageNo(w.activePage), zoom: w.zoomPercentage };
    }
  }
  throw E('bad_args', 'Unknown action ' + act, 'new|open|info|activate|save|save_copy|close|export|package|batch|undo|redo|preflight|zoom');
}

function batch(a) {
  // Open each .indd (no window), run fill/ops, preflight, export, optionally save, close. Already-open docs are reused and left open.
  var files = filesFrom(a, /\.indd$/i), out = [], ok = 0, i, k;
  if (!files.length) throw E('not_found', 'No .indd files', 'pass files[] or folder (+pattern, recursive)');
  if (a.export && a.export.dir && !Folder(a.export.dir).exists) Folder(a.export.dir).create();
  for (i = 0; i < files.length; i++) {
    var f = files[i], r = { file: f.fsName }, d = null, opened = false;
    for (var j = 0; j < app.documents.length; j++) { try { if (app.documents[j].fullName.fsName === f.fsName) d = app.documents[j]; } catch (e) {} }
    try {
      if (!d) { d = app.open(f, false); if (d instanceof Array) d = d[0]; opened = true; }
      D = d;
      if (a.fill) r.filled = OPS.fill(a.fill).total;
      if (a.ops) r.ops = apply({ ops: a.ops, keep_partial: a.keep_partial }).results.length;
      if (a.preflight) { var is = issues(d, 20); r.issues = { overset: is.overset.length, links: is.links.length, fonts: is.fonts.length }; }
      if (a.export) {
        var ex = {}; for (k in a.export) ex[k] = a.export[k];
        var fmt = lower(ex.format || 'pdf');
        ex.path = (ex.dir || f.parent.fsName) + '/' + fname(f).replace(/\.indd$/i, '') + (ex.suffix || '') + '.' + (fmt === 'jpeg' ? 'jpg' : fmt);
        r.export = exportFile(ex).path;
      }
      if (a.save && d.modified) {
        if (d.converted) throw E('converted', 'Saved by an older InDesign; not overwriting', 'open it and save with a new path');
        d.save(); r.saved = true;
      }
      r.ok = true; ok++;
    } catch (e2) { r.ok = false; r.error = String(e2.message || e2); }
    finally { if (opened && d && d.isValid) { try { d.close(SaveOptions.NO); } catch (e3) {} } }
    out.push(r);
  }
  return { files: files.length, ok: ok, failed: files.length - ok, results: out };
}

function status() {
  var o = { app: app.name, version: app.version, runtime: '%VERSION%', docs: [] }, i;
  for (i = 0; i < app.documents.length; i++) o.docs.push(docInfo(app.documents[i], true));
  if (app.documents.length) {
    var d = app.activeDocument; o.active = d.name;
    try { o.active_page = pageNo(app.activeWindow.activePage); } catch (e) {}
    o.selection = app.selection.length;
  }
  return o;
}

function capture(a) {
  var tmp = File(a.path);
  var pg = a.id !== undefined ? null : page(a.page);
  if (a.id !== undefined) {
    var it = item(a.id); var b = it.geometricBounds; var dim = Math.max(b[3] - b[1], b[2] - b[0]);
    app.pngExportPreferences.exportResolution = res(dim);
    app.pngExportPreferences.transparentBackground = false;
    it.exportFile(ExportFormat.PNG_FORMAT, tmp);
    return { path: tmp.fsName, id: it.id, resolution: app.pngExportPreferences.exportResolution };
  }
  var pb = pg.bounds, dm = Math.max(pb[3] - pb[1], pb[2] - pb[0]) * (a.spread ? 2 : 1);
  var ep = app.pngExportPreferences;
  ep.pngExportRange = PNGExportRangeEnum.EXPORT_RANGE; ep.pageString = '+' + pageNo(pg);
  ep.exportingSpread = !!a.spread; ep.transparentBackground = false; ep.exportResolution = res(dm);
  try { ep.pngQuality = PNGQualityEnum.HIGH; ep.antiAlias = true; ep.useDocumentBleeds = false; } catch (e) {}
  D.exportFile(ExportFormat.PNG_FORMAT, tmp, false);
  return { path: tmp.fsName, page: pageNo(pg), resolution: ep.exportResolution };
  function res(dimUnits) {
    var pt = dimUnits, px = a.max_px || 1400;
    var r = Math.floor(px * 72 / Math.max(pt, 1)); if (a.resolution) r = Math.min(a.resolution, r);
    return Math.max(10, Math.min(r, 600));
  }
}

function script(a) {
  var fn = new Function('A', 'doc', 'item', 'page', 'info', 'J', 'setProps', 'D', a.code);
  return fn(a.args || {}, doc, item, page, info, J, setProps, D);
}

// ---------- entry ----------
var UNITS = { mm: 'MILLIMETERS', cm: 'CENTIMETERS', pt: 'POINTS', 'in': 'INCHES', px: 'PIXELS', pica: 'PICAS' };
var PT_PER = { mm: 72 / 25.4, cm: 720 / 25.4, pt: 1, 'in': 72, px: 1, pica: 12 };
var sp = app.scriptPreferences, oldUI = sp.userInteractionLevel, oldMU = sp.measurementUnit, out;
try {
  sp.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
  if (A.units && !PT_PER[A.units]) throw E('bad_args', 'units must be mm|cm|pt|in|px|pica');
  U = PT_PER[A.units || 'mm'];
  // Everything runs in points (so pointSize/leading/strokeWeight are pt); geometry is converted via U.
  // The script tool instead gets the requested units directly (default pt).
  sp.measurementUnit = MeasurementUnits[TOOL === 'script' && A.units ? UNITS[A.units] : 'POINTS'];
  var r;
  if (TOOL === 'status') r = status();
  else if (TOOL === 'document') r = documentAction(A);
  else {
    D = doc(A.doc, TOOL === 'script');
    if (TOOL === 'read') r = read(A);
    else if (TOOL === 'apply') r = apply(A);
    else if (TOOL === 'capture') r = capture(A);
    else if (TOOL === 'script') r = script(A);
    else throw E('bad_args', 'unknown tool ' + TOOL);
  }
  out = '{"ok":true,"result":' + J(r) + '}';
} catch (e) {
  var er = { code: e.code || 'indesign_error', message: String(e.message || e) };
  if (e.next) er.next = e.next;
  if (!e.code && e.line) er.line = e.line;
  if (e.op !== undefined) er.op = e.op;
  if (e.done) er.done = e.done;
  if (e.rolled_back) er.rolled_back = e.rolled_back;
  out = '{"ok":false,"error":' + J(er) + '}';
} finally {
  sp.userInteractionLevel = oldUI;
  try { sp.measurementUnit = oldMU; } catch (e3) {}
}
return out;
} };
