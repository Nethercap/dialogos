'use strict';
// The page: who, which talk, and the talk written out as a tree of blocks. Saved on its own.
// (The project's setup page is in setup.js; the right-hand panel in panels.js.)

const S = {
	data: null, store: null,
	view: 'dialogue', charId: null, dlgId: null,
	dirty: false, saving: false, saveAgain: false, savedAt: null, offline: false, conflict: false,
	undo: [], redo: [], collapsed: new Set(), pendingFocus: null,
	// (things whose id still follows their name: made here, not yet pointed at)
	autoIds: new WeakSet(),
};

// ---------------------------------------------------------------- small helpers

function h(tag, props, ...kids) {
	const el = document.createElement(tag);
	for (const kid of kids.flat(Infinity)) {
		if (kid === null || kid === undefined || kid === false) continue;
		el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
	}
	for (const [k, v] of Object.entries(props || {})) {
		if (v === null || v === undefined) continue;
		if (k === 'class') el.className = v;
		else if (k === 'style') el.style.cssText = v;
		else if (k.startsWith('on')) el[k.toLowerCase()] = v;
		else if (k in el && k !== 'list') el[k] = v;
		else el.setAttribute(k, v);
	}
	return el;
}

const chars = () => S.data.characters;
const charById = id => chars().find(c => c.id === id);
const charName = id => id === NARRATOR ? t('Narrator') : (charById(id) || {name: id || '?'}).name;
const charColor = id => id === NARRATOR ? 'var(--dim)' : (charById(id) || {color: 'var(--dim)'}).color;
const dlgById = id => S.data.dialogues.find(d => d.id === id);
const dlgsOf = id => S.data.dialogues.filter(d => d.character === id);
const curDlg = () => dlgById(S.dlgId);
const nameIn = (list, id) => (list.find(x => x.id === id) || {name: id || '?'}).name;

// How conditions and effects put names in words (model.js).
const WORDS = {
	name: charName,
	title: id => (dlgById(id) || {title: '?'}).title || id || '?',
	stat: id => nameIn(S.data.stats, id),
	isGlobal: id => isGlobal(S.data, id),
	item: id => nameIn(S.data.items, id),
	place: id => nameIn(S.data.places, id),
	phase: id => nameIn(S.data.time.phases, id),
	weekday: id => nameIn(S.data.time.weekdays, id),
	list: (ids, fn) => (ids || []).map(fn).join(t(' or ')) || '?',
};

function toast(text) {
	const el = document.getElementById('toast');
	el.textContent = text;
	el.hidden = false;
	clearTimeout(toast.timer);
	toast.timer = setTimeout(() => { el.hidden = true; }, 3200);
}

// ---------------------------------------------------------------- changes, undo, saving

function snapshot() {
	const now = JSON.stringify(S.data);
	if (S.undo[S.undo.length - 1] !== now) S.undo.push(now);
	if (S.undo.length > 200) S.undo.shift();
	S.redo.length = 0;
}

// Something changed without the page needing to be drawn again (words being typed).
function changed() {
	S.dirty = true;
	drawSaveState();
	clearTimeout(changed.timer);
	changed.timer = setTimeout(saveNow, 600);
	clearTimeout(changed.panelTimer);
	changed.panelTimer = setTimeout(() => Panels.onEdit(), 500);
}

// A change of shape: undoable, then everything drawn again (`focus`: the field to land on).
function mutate(fn, focus) {
	snapshot();
	fn();
	S.pendingFocus = focus || null;
	changed();
	render();
}

function travel(from, to) {
	if (!from.length) return;
	to.push(JSON.stringify(S.data));
	S.data = JSON.parse(from.pop());
	fixSelection();
	changed();
	render();
	Panels.onStructure();
}

function fixSelection() {
	if (S.dlgId && !curDlg()) S.dlgId = null;
	if (!S.charId || !charById(S.charId)) S.charId = chars()[0].id;
}

async function saveNow() {
	clearTimeout(changed.timer);
	if (S.conflict) return;
	if (S.saving) {
		S.saveAgain = true;
		return;
	}
	if (!S.dirty) return;
	S.saving = true;
	S.dirty = false;
	drawSaveState();
	try {
		const res = await S.store.save(fileText(S.data));
		if (res.conflict) {
			S.dirty = true;
			S.conflict = true;
			drawConflict();
		} else {
			S.savedAt = new Date();
			S.offline = false;
		}
	} catch (e) {
		S.dirty = true;
		S.offline = true;
		clearTimeout(changed.timer);
		changed.timer = setTimeout(saveNow, 4000);
	}
	S.saving = false;
	drawSaveState();
	if (S.saveAgain) {
		S.saveAgain = false;
		saveNow();
	}
}

function drawSaveState() {
	const el = document.getElementById('save-state');
	if (!el) return;
	const browser = S.store.kind === 'browser';
	if (S.offline) {
		el.className = 'save bad';
		el.textContent = browser ? t('NOT SAVED: this browser won\'t keep it. Download the project.') : t('NOT SAVED: the Dialogos window was closed. Start it again without closing this page.');
	} else if (browser && S.store.fileError) {
		el.className = 'save bad';
		el.textContent = t('Couldn\'t write {file} (kept in this browser).', {file: S.store.fileName});
	} else if (S.dirty || S.saving) {
		el.className = 'save';
		el.textContent = t('Saving…');
	} else if (S.savedAt) {
		el.className = 'save good';
		const time = S.savedAt.toLocaleTimeString(I18N.lang, {hour: '2-digit', minute: '2-digit', second: '2-digit'});
		el.textContent = browser && !S.store.handle ? t('Saved in this browser {time}', {time}) : t('Saved {time}', {time});
	} else {
		el.className = 'save';
		el.textContent = browser && !S.store.handle ? t('Kept in this browser') : t('All saved');
	}
	const u = document.getElementById('undo-btn'), r = document.getElementById('redo-btn');
	if (u) u.disabled = !S.undo.length;
	if (r) r.disabled = !S.redo.length;
}

function drawConflict(foreignText) {
	const b = document.getElementById('banner');
	b.hidden = false;
	const browser = S.store.kind === 'browser';
	b.replaceChildren(
		h('span', {class: 'grow'}, browser
			? t('Another tab changed this project. Nothing was saved here, so nothing got overwritten.')
			: t('The file was changed elsewhere (another tab or program). Nothing was saved, so nothing got overwritten.')),
		h('button', {onclick: () => reloadFromStore(foreignText)}, browser ? t('Load the other tab\'s version') : t('Load the file\'s version')),
		h('button', {class: 'danger', onclick: () => forceSave()}, t('Overwrite it with this page')),
	);
}

async function forceSave() {
	try {
		const res = S.store.kind === 'server' ? await S.store.save(fileText(S.data), true) : await S.store.save(fileText(S.data));
		if (res.ok) {
			S.conflict = false;
			S.dirty = false;
			S.savedAt = new Date();
			document.getElementById('banner').hidden = true;
			drawSaveState();
		}
	} catch (e) {
		toast(String(e.message || e));
	}
}

async function reloadFromStore(foreignText) {
	try {
		const doc = foreignText ? JSON.parse(foreignText) : await S.store.load();
		if (foreignText) S.store.lastText = foreignText;
		S.data = normalizeProject(doc || newProject(I18N.lang));
	} catch (e) {
		toast(String(e.message || e));
		return;
	}
	S.conflict = false;
	S.dirty = false;
	S.undo.length = 0;
	S.redo.length = 0;
	document.getElementById('banner').hidden = true;
	fixSelection();
	render();
	Panels.onStructure();
}

// The file changed behind this page's back? Asked when coming back to the page.
async function checkDisk() {
	if (S.store.kind !== 'server' || S.conflict || S.saving) return;
	try {
		if (await S.store.unchanged()) return;
		if (S.dirty) {
			S.conflict = true;
			drawConflict();
		} else {
			await reloadFromStore();
			toast(t('The file had changed: loaded the new version.'));
		}
	} catch (e) { /* (the server's down: the next save says so) */ }
}

// ---------------------------------------------------------------- whole projects in and out

function projectIsEmpty() {
	return !S.data.dialogues.length && chars().length <= 1 && !S.data.stats.length && !S.data.places.length && !S.data.items.length;
}

function parseProject(text) {
	const doc = JSON.parse(text);
	if (!doc || typeof doc !== 'object' || !Array.isArray(doc.characters) || !Array.isArray(doc.dialogues)) {
		throw new Error(t('That file isn\'t a Dialogos project.'));
	}
	return normalizeProject(doc);
}

// Puts another project in place of this one. Undoable, unless `fresh` (a new file is now the one written).
function replaceProject(doc, fresh) {
	if (fresh) {
		S.data = doc;
		S.undo.length = 0;
		S.redo.length = 0;
		changed();
	} else {
		snapshot();
		S.data = doc;
		changed();
	}
	S.collapsed.clear();
	S.view = 'dialogue';
	const first = npcs(S.data)[0] || chars()[0];
	S.charId = first.id;
	S.dlgId = (dlgsOf(first.id)[0] || {id: null}).id;
	if (projectIsEmpty()) S.view = 'welcome';
	render();
	Panels.onStructure();
}

function confirmReplace() {
	if (projectIsEmpty()) return true;
	return confirm(S.store.kind === 'browser' && !S.store.handle
		? t('Replace the project that\'s open? It\'s only kept in this browser: download it first if you want to keep it.')
		: t('Replace the project that\'s open? (Undo brings it back.)'));
}

async function openFile() {
	let got;
	try {
		got = await pickFile();
	} catch (e) {
		return toast(String(e.message || e));
	}
	if (!got) return;
	let doc;
	try {
		doc = parseProject(got.text);
	} catch (e) {
		return toast(t('Couldn\'t read {file}: {error}', {file: got.name, error: e.message}));
	}
	if (!confirmReplace()) return;
	if (S.store.kind === 'browser') {
		S.store.link(got.handle, got.name);
		replaceProject(doc, true);
		toast(got.handle ? t('Opened {file}: changes are saved to it.', {file: got.name}) : t('Opened {file}. This browser can\'t write files: use Download to keep it.', {file: got.name}));
	} else {
		replaceProject(doc, false);
		toast(t('Imported {file} into {path}.', {file: got.name, path: S.store.path}));
	}
}

async function saveAs() {
	let handle;
	try {
		handle = await pickSaveFile(fileName());
	} catch (e) {
		return toast(String(e.message || e));
	}
	if (!handle) return;
	S.store.link(handle, handle.name);
	S.dirty = true;
	await saveNow();
	render();
	toast(t('Saving to {file} from now on.', {file: handle.name}));
}

function newEmpty() {
	if (!confirmReplace()) return;
	if (S.store.kind === 'browser') {
		S.store.link(null, '');
		replaceProject(newProject(I18N.lang), true);
	} else {
		replaceProject(newProject(I18N.lang), false);
	}
}

async function loadExample(quiet) {
	let doc;
	try {
		const res = await fetch('../examples/cafe.json', {cache: 'no-store'});
		doc = parseProject(await res.text());
	} catch (e) {
		return toast(t('Couldn\'t load the example from here: open examples/cafe.json with “Open a file…”.'));
	}
	if (!confirmReplace()) return;
	if (S.store.kind === 'browser') S.store.link(null, '');
	replaceProject(doc, S.store.kind === 'browser');
	if (quiet !== true) toast(t('The example is open. Change anything: it\'s yours.'));
}

function fileName(ext = '.json') {
	return (slug(S.data.title) || 'dialogos') + ext;
}

// ---------------------------------------------------------------- bound fields

// A field tied to obj[key]: what's typed goes to the data at once, an undo step per visit to it.
function bind(el, obj, key, after) {
	let snapped = false;
	el.addEventListener('focus', () => { snapped = false; });
	el.addEventListener('input', () => {
		if (!snapped) {
			snapshot();
			snapped = true;
		}
		obj[key] = el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value;
		if (el.tagName === 'TEXTAREA') grow(el);
		if (after) after();
		changed();
	});
	return el;
}

function grow(el) {
	el.style.height = 'auto';
	el.style.height = el.scrollHeight + 2 + 'px';
}

function textField(obj, key, props, after) {
	return bind(h('textarea', {rows: 1, value: obj[key] || '', ...props}), obj, key, after);
}

function inputField(obj, key, props, after) {
	return bind(h('input', {value: obj[key] || '', ...props}), obj, key, after);
}

function numField(obj, key, props) {
	const v = obj[key];
	return bind(h('input', {type: 'number', value: v === null || v === undefined ? '' : v, ...props}), obj, key);
}

function selectField(obj, key, options, after) {
	const el = h('select', null, options.map(([v, label]) => h('option', {value: v}, label)));
	el.value = obj[key] === undefined || obj[key] === null ? '' : String(obj[key]);
	el.onchange = () => mutate(() => {
		obj[key] = el.value;
		if (after) after();
	});
	return el;
}

function checkbox(obj, key, label, title) {
	return h('label', {title}, h('input', {type: 'checkbox', checked: !!obj[key], onchange: e => mutate(() => { obj[key] = e.target.checked; })}), label);
}

function boolSelect(obj, key, yes, no) {
	const el = h('select', null, h('option', {value: '1'}, yes), h('option', {value: ''}, no));
	el.value = obj[key] !== false ? '1' : '';
	el.onchange = () => mutate(() => { obj[key] = el.value === '1'; });
	return el;
}

// The characters, grouped. opts: player (default true), narrator, except (an id to leave out).
function charOptions({player = true, narrator = false, except = null} = {}) {
	const out = [];
	const me = charById(PLAYER);
	if (player && except !== PLAYER) out.push(h('option', {value: PLAYER}, me ? me.name : PLAYER));
	if (narrator) out.push(h('option', {value: NARRATOR}, t('Narrator')));
	const groups = new Map();
	for (const c of chars()) {
		if (c.id === PLAYER || c.id === except) continue;
		if (!groups.has(c.group)) groups.set(c.group, []);
		groups.get(c.group).push(c);
	}
	for (const [g, list] of groups) out.push(h('optgroup', {label: g}, list.map(c => h('option', {value: c.id}, c.name))));
	return out;
}

function charSelect(obj, key, opts) {
	const el = h('select', {class: 'who-select', style: `--c:${charColor(obj[key])}`}, charOptions(opts));
	if (obj[key] && !charById(obj[key]) && obj[key] !== NARRATOR) el.append(h('option', {value: obj[key]}, '⚠ ' + obj[key]));
	el.value = obj[key] || '';
	el.onchange = () => mutate(() => { obj[key] = el.value; });
	return el;
}

// A select over [{id, name}]; `blank`: the label of "none".
function listSelect(obj, key, list, blank, after) {
	const el = h('select', null, blank !== undefined ? h('option', {value: ''}, blank) : null, list.map(x => h('option', {value: x.id}, x.name)));
	if (obj[key] && !list.some(x => x.id === obj[key])) el.append(h('option', {value: obj[key]}, '⚠ ' + obj[key]));
	el.value = obj[key] || '';
	el.onchange = () => mutate(() => {
		obj[key] = el.value;
		if (after) after();
	});
	return el;
}

// A list of ids as chips, and a select to add one more of [{id, name}].
function chipPicker(list, options, addLabel) {
	const add = h('select', {class: 'chip-add'}, h('option', {value: ''}, addLabel),
		options.filter(x => !list.includes(x.id)).map(x => h('option', {value: x.id}, x.name)));
	add.onchange = () => {
		if (add.value) mutate(() => list.push(add.value));
	};
	return h('span', {class: 'chips'},
		list.map((id, i) => {
			const known = options.find(x => x.id === id);
			return h('span', {class: 'chip' + (known ? '' : ' bad')}, known ? known.name : '⚠ ' + id,
				h('button', {title: t('Remove'), onclick: () => mutate(() => list.splice(i, 1))}, '×'));
		}),
		add.options.length > 1 ? add : null);
}

// Free words as chips (moods, tags): typed, Enter or comma to add.
function wordChips(list, placeholder, suggestions) {
	const dl = suggestions && suggestions.length ? 'dl-' + Math.random().toString(36).slice(2) : null;
	const input = h('input', {placeholder, list: dl});
	const commit = () => {
		const words = input.value.split(',').map(w => w.trim()).filter(w => w && !list.includes(w));
		input.value = '';
		if (words.length) mutate(() => list.push(...words));
	};
	input.onkeydown = e => {
		if (e.key === 'Enter' || e.key === ',') {
			e.preventDefault();
			commit();
		}
	};
	input.onchange = () => { if (dl) commit(); };
	input.onblur = commit;
	return h('span', {class: 'chips'},
		list.map((w, i) => h('span', {class: 'chip'}, w, h('button', {title: t('Remove'), onclick: () => mutate(() => list.splice(i, 1))}, '×'))),
		input,
		dl ? h('datalist', {id: dl}, suggestions.filter(s => !list.includes(s)).map(s => h('option', {value: s}))) : null);
}

// An id that can be changed: everything that points at it follows.
function idField(kind, obj, taken, after) {
	const el = h('input', {class: 'id-field mono', value: obj.id, title: t('The id the game uses. Changing it updates everything that points at it.'), spellcheck: false});
	el.onchange = () => {
		const want = slug(el.value);
		if (!want || want === obj.id) {
			el.value = obj.id;
			return;
		}
		if (taken().has(want)) {
			el.value = obj.id;
			return toast(t('The id “{id}” is taken.', {id: want}));
		}
		const from = obj.id;
		mutate(() => {
			renameRefs(S.data, kind, from, want);
			obj.id = want;
			S.autoIds.delete(obj);
			if (after) after(from, want);
		});
	};
	return el;
}

// A name field whose thing's id follows it (as base() says) while nothing points at it yet.
function nameFollows(el, kind, obj, taken, base, after) {
	el.addEventListener('blur', () => {
		if (!S.autoIds.has(obj) || !slug(base()) || countRefs(S.data, kind, obj.id)) return;
		const others = taken();
		others.delete(obj.id);
		const want = idFor(base(), others, kind);
		if (want === obj.id) return;
		const from = obj.id;
		obj.id = want;
		if (after) after(from, want);
		changed();
		render();
	});
	return el;
}

// ---------------------------------------------------------------- the bar on top

function renderTop() {
	const ui = h('select', {title: t('Language of this page')}, Object.entries(LANGUAGES).map(([k, v]) => h('option', {value: k}, v)));
	ui.value = I18N.lang;
	ui.onchange = () => {
		setLanguage(ui.value);
		render();
		Panels.onStructure();
	};
	const browser = S.store.kind === 'browser';
	const where = browser
		? (S.store.handle ? S.store.fileName : t('in this browser'))
		: S.store.label();
	const menu = h('details', {class: 'menu'},
		h('summary', null, t('File')),
		h('div', {class: 'menu-list'},
			h('button', {onclick: newEmpty}, t('New empty project')),
			h('button', {onclick: openFile}, browser ? t('Open a file…') : t('Import a file…')),
			browser && S.store.canLink ? h('button', {onclick: saveAs}, t('Save to a file…')) : null,
			h('button', {onclick: loadExample}, t('Open the example')),
			h('hr'),
			h('button', {onclick: () => download(fileText(S.data), fileName())}, t('Download .json')),
			h('button', {onclick: () => download(toCSV(S.data), fileName('.csv'), 'text/csv'), title: t('Every line, for translators or voice actors')}, t('Export the text (.csv)')),
		));
	menu.addEventListener('click', e => { if (e.target.tagName === 'BUTTON') menu.open = false; });
	document.getElementById('top').replaceChildren(
		h('span', {class: 'brand'}, 'Dialogos'),
		h('span', {class: 'project-title'}, S.data.title || t('Untitled')),
		h('span', {class: 'mono where', title: browser ? t('Where the project is kept') : t('The file being written')}, where),
		h('span', {class: 'grow'}),
		h('span', {id: 'save-state', class: 'save'}),
		h('button', {id: 'undo-btn', title: t('Undo') + ' (Ctrl+Z)', onclick: () => travel(S.undo, S.redo)}, '↶'),
		h('button', {id: 'redo-btn', title: t('Redo') + ' (Ctrl+Y)', onclick: () => travel(S.redo, S.undo)}, '↷'),
		menu,
		ui,
		h('button', {title: t('Light or dark'), onclick: cycleTheme}, themeIcon()),
		h('button', {
			class: document.getElementById('app').classList.contains('no-panel') ? '' : 'on',
			title: t('Show or hide the panel to try talks out'),
			onclick: () => {
				const app = document.getElementById('app');
				app.classList.toggle('no-panel');
				try { localStorage.setItem('dialogos.noPanel', app.classList.contains('no-panel') ? '1' : ''); } catch (e) { /* (only a preference) */ }
				renderTop();
			},
		}, t('Try / Map')),
	);
	drawSaveState();
}

function themeIcon() {
	const th = document.documentElement.dataset.theme || 'auto';
	return th === 'light' ? '☀' : th === 'dark' ? '☾' : '◐';
}

function cycleTheme() {
	const order = ['auto', 'light', 'dark'];
	const now = document.documentElement.dataset.theme || 'auto';
	const next = order[(order.indexOf(now) + 1) % order.length];
	if (next === 'auto') delete document.documentElement.dataset.theme;
	else document.documentElement.dataset.theme = next;
	try { localStorage.setItem('dialogos.theme', next); } catch (e) { /* (only a preference) */ }
	renderTop();
}

// ---------------------------------------------------------------- left: who and which talk

function renderSide() {
	const out = [h('button', {class: 'setup-btn' + (S.view === 'project' ? ' on' : ''), onclick: () => { S.view = 'project'; render(); }}, '⚙ ', t('Project setup'))];
	const groups = new Map();
	for (const c of chars()) {
		if (!groups.has(c.group)) groups.set(c.group, []);
		groups.get(c.group).push(c);
	}
	for (const [g, list] of groups) {
		out.push(h('div', {class: 'side-title'}, g));
		for (const c of list) {
			out.push(h('button', {
				class: 'char-btn' + (c.id === S.charId && S.view !== 'project' ? ' on' : ''), style: `--c:${c.color}`,
				onclick: () => selectChar(c.id),
			}, h('span', {class: 'dot'}), c.name, h('span', {class: 'count'}, dlgsOf(c.id).length || '')));
		}
	}
	out.push(h('div', {class: 'side-actions'}, h('button', {class: 'add', onclick: addCharacter}, '+ ' + t('Character'))));

	const c = charById(S.charId);
	if (c && S.view !== 'project') {
		out.push(h('div', {class: 'side-title'}, t('Talks of {name}', {name: c.name})));
		const list = dlgsOf(c.id);
		list.forEach((d, i) => {
			out.push(h('div', {class: 'dlg-row'},
				h('button', {
					class: 'dlg-btn' + (d.id === S.dlgId && S.view === 'dialogue' ? ' on' : ''),
					title: d.status === 'ready' ? t('Ready') : t('Draft'),
					onclick: () => selectDlg(d.id),
				}, h('span', {class: 'status-dot' + (d.status === 'ready' ? ' ready' : '')}), h('span', {class: 'dlg-name'}, d.title || h('i', {class: 'dim'}, t('untitled')))),
				h('span', {class: 'moves'},
					h('button', {class: 'ghost', title: t('Earlier'), disabled: i === 0, onclick: () => moveDlg(d, list[i - 1])}, '▲'),
					h('button', {class: 'ghost', title: t('Later'), disabled: i === list.length - 1, onclick: () => moveDlg(d, list[i + 1])}, '▼')),
			));
		});
		out.push(h('div', {class: 'side-actions'}, h('button', {class: 'add', onclick: () => addDialogue(c.id)}, '+ ' + t('Talk'))));
	}
	document.getElementById('side').replaceChildren(...out);
}

function selectChar(id) {
	S.charId = id;
	S.view = 'dialogue';
	const first = dlgsOf(id)[0];
	S.dlgId = first ? first.id : null;
	render();
	Panels.onStructure();
}

function selectDlg(id) {
	const d = dlgById(id);
	if (!d) return;
	S.dlgId = id;
	S.charId = d.character;
	S.view = 'dialogue';
	render();
	Panels.onStructure();
}

function moveDlg(a, b) {
	mutate(() => {
		const all = S.data.dialogues;
		const i = all.indexOf(a), j = all.indexOf(b);
		all[i] = b;
		all[j] = a;
	});
}

function addCharacter() {
	const taken = new Set(chars().map(c => c.id));
	const c = {id: nextFreeId('character_', taken), name: t('New character'), group: t('Characters'), color: PALETTE[chars().length % PALETTE.length],
		notes: '', moods: [], stats: {}, likes: [], dislikes: [], relations: []};
	S.autoIds.add(c);
	mutate(() => {
		chars().push(c);
		S.charId = c.id;
		S.view = 'character';
		S.dlgId = null;
	}, 'char-name');
}

function addDialogue(owner) {
	const taken = new Set(S.data.dialogues.map(d => d.id));
	const id = nextFreeId(owner + '_', taken);
	const who = defaultWho({character: owner});
	const first = newNode(owner === PLAYER ? 'line' : 'choice', who);
	if (owner !== PLAYER) {
		first.options = [normalizeOption({id: 'o1', reply: [{who, text: ''}]}), normalizeOption({id: 'o2', reply: [{who, text: ''}]})];
	}
	const d = {id, character: owner, title: '', status: 'draft', places: [], required: false, repeat: false, if: [], notes: '', start: 'n1', nodes: {n1: first}};
	S.autoIds.add(d);
	mutate(() => {
		S.data.dialogues.push(d);
		S.dlgId = id;
		S.charId = owner;
		S.view = 'dialogue';
	}, id + ':title');
	Panels.onStructure();
}

// ---------------------------------------------------------------- the middle

function renderMain() {
	const main = document.getElementById('main');
	const top = main.scrollTop;
	if (S.view === 'project') main.replaceChildren(renderProject());
	else if (S.view === 'welcome') main.replaceChildren(renderWelcome());
	else if (S.view === 'character') main.replaceChildren(renderCharacter(charById(S.charId)));
	else if (curDlg()) main.replaceChildren(renderDialogue(curDlg()));
	else main.replaceChildren(renderNoTalks(charById(S.charId)));
	main.scrollTop = top;
	main.querySelectorAll('textarea').forEach(grow);
}

function renderWelcome() {
	return h('div', {class: 'empty welcome'},
		h('h2', null, t('An empty project')),
		h('p', null, t('First say what your game keeps track of (trust, romance, money…), its places, its items and its parts of the day. Then add characters and write their talks.')),
		h('div', {class: 'add-row'},
			h('button', {class: 'primary', onclick: () => { S.view = 'project'; render(); }}, '⚙ ' + t('Project setup')),
			h('button', {onclick: addCharacter}, '+ ' + t('Character')),
			h('button', {onclick: loadExample}, t('Open the example'))),
		h('p', {class: 'dim tiny'}, S.store.kind === 'browser'
			? t('Everything is kept in this browser as you type. Use File to save it to a file or download it.')
			: t('Everything is saved to {file} as you type.', {file: S.store.path})),
	);
}

function renderNoTalks(c) {
	return h('div', {class: 'empty'},
		h('h2', null, t('No talks of {name} yet', {name: c.name})),
		h('div', null, c.id === PLAYER
			? t('The player\'s own talks: thoughts, things they read, scenes with no one else.')
			: t('A talk is what the character says, what the player can answer, and what is said after each answer.')),
		h('div', {class: 'add-row'},
			h('button', {class: 'primary', onclick: () => addDialogue(c.id)}, '+ ' + t('Write a talk')),
			h('button', {onclick: () => { S.view = 'character'; render(); }}, t('See their sheet'))),
	);
}

function statRanges(d) {
	if (d.character === PLAYER) return [];
	const out = [];
	for (const s of charStats(S.data)) {
		const [lo, hi] = statRange(d, s.id);
		if (lo || hi) out.push(h('span', {class: 'range', style: `--c:${s.color}`}, s.name, ' ', lo === hi ? signed(lo) : `${signed(lo)} … ${signed(hi)}`));
	}
	return out;
}

function renderDialogue(d) {
	const c = charById(d.character);
	const owner = d.character;
	const seen = new Set();
	const tree = renderNode(d, d.start, seen);
	const loose = Object.keys(d.nodes).filter(id => !seen.has(id));
	const looseEls = [];
	for (const id of loose) if (!seen.has(id)) looseEls.push(renderNode(d, id, seen));
	const ranges = statRanges(d);
	const dlgIds = () => new Set(S.data.dialogues.map(x => x.id));
	const titleEl = inputField(d, 'title', {class: 'title-input', placeholder: t('Title of the talk'), 'data-fk': d.id + ':title'}, renderSide);
	nameFollows(titleEl, 'dialogue', d, dlgIds, () => d.title ? owner + ' ' + d.title : '', (from, to) => { S.dlgId = to; });
	return h('div', null,
		h('div', {class: 'crumbs'},
			h('button', {class: 'who-chip', style: `--c:${charColor(owner)}`, title: t('See their sheet'), onclick: () => { S.view = 'character'; render(); }},
				h('span', {class: 'dot'}), c ? c.name : owner),
			titleEl,
			selectField(d, 'status', [['draft', t('Draft')], ['ready', t('Ready')]], renderSide),
			h('button', {title: t('A copy, to write a variant'), onclick: () => duplicateDlg(d)}, t('Duplicate')),
			h('button', {class: 'danger', onclick: () => deleteDlg(d)}, t('Delete')),
		),
		h('div', {class: 'when'},
			h('div', {class: 'when-row'},
				h('b', {class: 'when-title'}, t('When it happens')),
				h('label', null, t('Where'), S.data.places.length
					? chipPicker(d.places, S.data.places, d.places.length ? '+' : t('anywhere'))
					: h('span', {class: 'dim tiny'}, t('anywhere'))),
				checkbox(d, 'required', t('Required (story)'), t('A talk the story needs: the game should make sure it happens')),
				checkbox(d, 'repeat', t('Can repeat'), t('It can happen again once it\'s been seen')),
				h('span', {class: 'grow'}),
				h('label', {class: 'dim tiny'}, 'id', idField('dialogue', d, () => { const s = dlgIds(); s.delete(d.id); return s; }, (from, to) => { S.dlgId = to; })),
			),
			renderConds(d.if, d, t('Only if'), false),
			h('div', {class: 'add-row'}, addCondButton(d.if, d, '+ ' + t('Only if…'), false),
				ranges.length ? h('span', {class: 'ranges', title: t('The least and the most this talk can change, depending on what the player picks')}, t('Changes:'), ranges) : null),
			textField(d, 'notes', {placeholder: t('Notes for whoever puts this in the game, or for you…')}),
		),
		tree,
		looseEls.length ? h('div', {class: 'loose-title', title: t('Nothing leads to these: link them with “Then”, or delete them')}, t('Loose blocks (nothing leads here)')) : null,
		looseEls,
	);
}

function duplicateDlg(d) {
	const taken = new Set(S.data.dialogues.map(x => x.id));
	const copy = clone(d);
	copy.id = nextFreeId(d.character + '_', taken);
	copy.title = t('{title} (copy)', {title: d.title || t('Talk')});
	mutate(() => {
		S.data.dialogues.splice(S.data.dialogues.indexOf(d) + 1, 0, copy);
		S.dlgId = copy.id;
	}, copy.id + ':title');
	Panels.onStructure();
}

function deleteDlg(d) {
	if (!confirm(t('Delete the talk “{title}”?', {title: d.title || d.id}))) return;
	mutate(() => {
		const list = dlgsOf(d.character);
		const i = list.indexOf(d);
		S.data.dialogues.splice(S.data.dialogues.indexOf(d), 1);
		const next = list[i + 1] || list[i - 1];
		S.dlgId = next ? next.id : null;
	});
	Panels.onStructure();
	toast(t('Talk deleted. Undo brings it back.'));
}

// ---------------------------------------------------------------- a block

function renderNode(d, id, seen) {
	const n = d.nodes[id];
	if (!n) return null;
	seen.add(id);
	const owner = d.character;
	const body = [];
	if (n.mode !== 'line') {
		n.options.forEach((o, i) => body.push(renderOption(d, n, id, o, i, seen)));
		body.push(h('div', {class: 'add-row'}, h('button', {
			class: 'add',
			onclick: () => {
				const o = newOption(d);
				o.reply = [{who: defaultWho(d), text: ''}];
				if (n.mode === 'give') o.if = [newCond(defaultCondType(S.data, owner, true), S.data, owner)];
				mutate(() => n.options.push(o), `${d.id}:${id}:${o.id}:text`);
			},
		}, n.mode === 'choice' ? '+ ' + t('Player option') : '+ ' + t('Branch'))));
	}
	return h('div', {class: 'block', 'data-node': id},
		h('div', {class: 'block-head'},
			h('span', {class: 'mono'}, d.start === id ? t('Starts here') + ' · ' + id : id),
			h('span', {class: 'grow'}),
			h('button', {class: 'ghost tiny', title: t('Try it from this block'), onclick: () => Panels.playFrom(id)}, '▶ ' + t('Try')),
			d.start !== id ? h('button', {class: 'ghost tiny', title: t('Make the talk start at this block'), onclick: () => mutate(() => { d.start = id; })}, t('Start here')) : null,
			d.start !== id ? h('button', {class: 'ghost tiny danger', title: t('Delete this block (what came from it is left loose)'), onclick: () => deleteNode(d, id)}, t('Delete')) : null,
		),
		renderLines(d, n.lines, `${d.id}:${id}:L`),
		renderEffects(n.effects, d, null),
		h('div', {class: 'add-row'}, addEffectButton(n.effects, d, '+ ' + t('Also…'), t('Something that happens once these lines are said'))),
		h('div', {class: 'modes'},
			h('span', {class: 'label'}, t('And then:')),
			MODES.map(([mode, label, tip]) => h('button', {class: n.mode === mode ? 'on' : '', title: t(tip), onclick: () => setMode(d, n, mode)}, t(label)))),
		n.mode === 'give' ? h('div', {class: 'order'}, t('What they ask for:'),
			listSelect(n.ask, 'item', S.data.items, t('— anything —')),
			t('or in words'), inputField(n.ask, 'text', {placeholder: t('something sweet'), style: 'width:180px'})) : null,
		body,
		n.mode === 'line' ? renderAfter(d, n, id, seen, false) : null,
	);
}

function setMode(d, n, mode) {
	if (n.mode === mode) return;
	mutate(() => {
		const owner = d.character;
		const fresh = conds => {
			const o = newOption(d);
			o.if = conds;
			o.reply = [{who: defaultWho(d), text: ''}];
			n.options.push(o);
		};
		if (mode !== 'line' && !n.options.length) {
			if (mode === 'give') {
				fresh([owner !== PLAYER ? {type: 'given_liked'} : newCond('given', S.data, owner)]);
				fresh([]);
			} else if (mode === 'branch') {
				fresh([newCond(defaultCondType(S.data, owner, false), S.data, owner)]);
				fresh([]);
			} else {
				fresh([]);
				fresh([]);
			}
		}
		if (mode !== 'choice') for (const o of n.options) if (o.next === 'back') o.next = 'end';
		n.mode = mode;
	});
}

function deleteNode(d, id) {
	mutate(() => {
		for (const n of Object.values(d.nodes)) {
			if (n.next === id) n.next = 'end';
			for (const o of n.options) if (o.next === id) o.next = 'end';
		}
		delete d.nodes[id];
	});
	Panels.onStructure();
	toast(t('Block deleted. Undo brings it back.'));
}

// ---------------------------------------------------------------- lines

function fitLabel(el, text, max) {
	const over = max && text.length > max;
	el.textContent = max && text.length > max * 0.8 ? `${text.length}/${max}` : '';
	el.className = 'fit' + (over ? ' over' : '');
}

// Who says a line, and in which mood: one list, "Mia", "Mia · happy", "Mia · sad"…
function lineWho(ln, key) {
	const opt = (value, label) => h('option', {value}, label);
	const withMoods = c => [opt(c.id, c.name), ...c.moods.map(m => opt(c.id + '|' + m, `${c.name} · ${m}`))];
	const groups = new Map();
	for (const c of chars()) {
		if (c.id === PLAYER) continue;
		if (!groups.has(c.group)) groups.set(c.group, []);
		groups.get(c.group).push(c);
	}
	const me = charById(PLAYER);
	const el = h('select', {title: t('Who says it, and in which mood'), class: 'who-select', style: `--c:${charColor(ln.who)}`},
		me ? withMoods(me) : null,
		opt(NARRATOR, t('Narrator')),
		[...groups].map(([g, list]) => h('optgroup', {label: g}, list.flatMap(withMoods))));
	const value = ln.mood ? ln.who + '|' + ln.mood : ln.who;
	if (![...el.options].some(o => o.value === value)) el.append(opt(value, '⚠ ' + charName(ln.who) + (ln.mood ? ' · ' + ln.mood : '')));
	el.value = value;
	el.onchange = () => mutate(() => {
		const cut = el.value.indexOf('|');
		ln.who = cut < 0 ? el.value : el.value.slice(0, cut);
		if (cut < 0) delete ln.mood;
		else ln.mood = el.value.slice(cut + 1);
	}, key);
	return el;
}

function renderLines(d, arr, keyBase) {
	const max = S.data.limits.lineChars;
	const rows = arr.map((ln, i) => {
		const key = keyBase + i;
		const hint = h('span', {class: 'fit'});
		fitLabel(hint, ln.text, max);
		const ta = textField(ln, 'text', {
			placeholder: ln.who === NARRATOR ? t('What happens, with no one saying it…') : t('What they say…'), 'data-fk': key,
		}, () => fitLabel(hint, ln.text, max));
		ta.addEventListener('keydown', e => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				mutate(() => arr.splice(i + 1, 0, {who: ln.who, text: ''}), keyBase + (i + 1));
			} else if (e.key === 'Backspace' && !ln.text && arr.length > 1) {
				e.preventDefault();
				mutate(() => arr.splice(i, 1), keyBase + Math.max(0, i - 1));
			}
		});
		return h('div', {class: 'line' + (ln.who === NARRATOR ? ' narrator' : '')},
			lineWho(ln, key),
			h('div', null, ta, hint),
			h('span', {class: 'line-tools'},
				h('button', {class: 'ghost', title: t('Up'), disabled: i === 0, onclick: () => mutate(() => arr.splice(i - 1, 2, arr[i], arr[i - 1]))}, '▲'),
				h('button', {class: 'ghost', title: t('Down'), disabled: i === arr.length - 1, onclick: () => mutate(() => arr.splice(i, 2, arr[i + 1], arr[i]))}, '▼'),
				h('button', {class: 'ghost', title: t('Delete line'), onclick: () => mutate(() => arr.splice(i, 1))}, '×')),
		);
	});
	return h('div', {class: 'lines'}, rows,
		h('div', {class: 'add-row'}, h('button', {
			class: 'add', title: t('Also: Enter at the end of a line'),
			onclick: () => {
				const who = arr.length ? arr[arr.length - 1].who : defaultWho(d);
				mutate(() => arr.push({who, text: ''}), keyBase + arr.length);
			},
		}, '+ ' + t('Line'))));
}

// ---------------------------------------------------------------- an option or a branch

// The option's change to one of its owner's stats, as a − n + control (it's an effect underneath).
function statStepper(o, owner, s) {
	const v = statGain(o, owner, s.id);
	const step = by => mutate(() => setOwnerGain(o, owner, s.id, v + by));
	return h('span', {class: 'stepper ' + (v > 0 ? 'plus' : v < 0 ? 'minus' : ''), title: t('How much this changes the {stat} of {who}', {stat: s.name, who: charName(owner)})},
		h('span', {class: 'stepper-name', style: `--c:${s.color}`}, s.name),
		h('button', {onclick: () => step(-1)}, '−'),
		h('output', null, signed(v)),
		h('button', {onclick: () => step(1)}, '+'));
}

function setOwnerGain(o, owner, statId, value) {
	const mine = e => e.type === 'stat' && e.stat === statId && (e.who || owner) === owner;
	let first = null;
	const kept = [];
	for (const e of o.effects) {
		if (!mine(e)) kept.push(e);
		else if (!first) first = e;
	}
	if (value) {
		first = first || {type: 'stat', stat: statId, who: owner, delta: 0};
		first.who = owner;
		first.delta = value;
		kept.unshift(first);
	}
	o.effects.splice(0, o.effects.length, ...kept);
}

function renderOption(d, n, nodeId, o, i, seen) {
	const owner = d.character;
	const key = `${d.id}:${nodeId}:${o.id}`;
	const isChoice = n.mode === 'choice';
	const open = !S.collapsed.has(key);
	const steppers = owner !== PLAYER ? charStats(S.data) : [];
	let label = null;
	if (!isChoice) {
		if (n.mode === 'random') label = o.if.length ? t('One at random (if it holds)') : t('One at random');
		else label = o.if.length ? t('If…') : t('Otherwise (any other case)');
	}
	const moveOpt = by => mutate(() => {
		n.options.splice(i, 1);
		n.options.splice(i + by, 0, o);
	});
	const head = h('div', {class: 'opt-head'},
		h('button', {class: 'ghost caret', title: open ? t('Fold') : t('Unfold'), onclick: () => { open ? S.collapsed.add(key) : S.collapsed.delete(key); render(); }}, open ? '▾' : '▸'),
		isChoice ? h('span', {class: 'num'}, (i + 1) + '.') : h('span', {class: 'branch-label'}, label),
		isChoice ? optionText(o, key) : null,
		h('span', {class: 'opt-tools'},
			h('button', {class: 'ghost', title: t('Up'), disabled: i === 0, onclick: () => moveOpt(-1)}, '▲'),
			h('button', {class: 'ghost', title: t('Down'), disabled: i === n.options.length - 1, onclick: () => moveOpt(1)}, '▼'),
			h('button', {class: 'ghost', title: t('Delete'), onclick: () => mutate(() => n.options.splice(i, 1))}, '×')));
	if (!open) {
		const first = o.reply[0];
		const gains = steppers.map(s => [s, statGain(o, owner, s.id)]).filter(([, v]) => v).map(([s, v]) => `${s.name} ${signed(v)}`);
		markSeen(d, o.next, seen);
		return h('div', {class: 'option'}, head,
			h('div', {class: 'collapsed-hint'}, first ? `${charName(first.who)}: ${first.text}` : t('(no reply)'), gains.length ? '  ·  ' + gains.join(', ') : ''));
	}
	return h('div', {class: 'option'}, head,
		h('div', {class: 'opt-body'},
			steppers.length ? h('div', {class: 'meta'}, steppers.map(s => statStepper(o, owner, s))) : null,
			renderConds(o.if, d, isChoice ? t('Shown if') : t('If'), n.mode === 'give'),
			renderEffects(o.effects, d, steppers.length ? owner : null),
			h('div', {class: 'add-row', style: 'margin:0 0 6px'},
				addCondButton(o.if, d, n.mode === 'give' ? '+ ' + t('If they were given…') : '+ ' + t('Only if…'), n.mode === 'give'),
				addEffectButton(o.effects, d, '+ ' + t('Also…'), t('Another effect: a stat, a flag, an item, time going by…'))),
			h('div', {class: 'reply-title'}, isChoice ? t('What is said next:') : t('What is said:')),
			renderLines(d, o.reply, `${key}:R`),
			renderAfter(d, o, nodeId, seen, isChoice),
		));
}

// (what's folded under here still counts as seen, or it'd show as loose)
function markSeen(d, id, seen) {
	const walk = x => {
		if (seen.has(x) || !d.nodes[x]) return;
		seen.add(x);
		nodeNexts(d.nodes[x]).forEach(walk);
	};
	walk(id);
}

function optionText(o, key) {
	const max = S.data.limits.optionChars;
	const warn = () => {
		const over = max && o.text.length > max;
		ta.classList.toggle('over', !!over);
		ta.title = over ? t('Too long for the text box ({n} characters, {max} fit)', {n: o.text.length, max}) : '';
	};
	const ta = textField(o, 'text', {placeholder: t('What the player can say…'), 'data-fk': key + ':text', class: 'option-text'}, warn);
	warn();
	ta.addEventListener('keydown', e => {
		if (e.key === 'Enter') {
			e.preventDefault();
			const next = document.querySelector(`[data-fk="${key}:R0"]`);
			if (next) next.focus();
		}
	});
	return h('div', {style: 'flex:1;min-width:0'}, ta);
}

// "Then": where this goes. A block only this leads to is drawn right under it.
function renderAfter(d, holder, nodeId, seen, canGoBack) {
	const el = h('select', null,
		h('option', {value: 'end'}, t('The talk ends')),
		canGoBack ? h('option', {value: 'back', title: t('Without the one already picked')}, t('Choose again')) : null,
		h('option', {value: '__new'}, '+ ' + t('Goes on in a new block')),
		Object.keys(d.nodes).filter(id => id !== nodeId).map(id => h('option', {value: id}, nodeLabel(d, id))));
	el.value = holder.next;
	el.onchange = () => {
		if (el.value === '__new') {
			const id = nextFreeId('n', new Set(Object.keys(d.nodes)));
			mutate(() => {
				d.nodes[id] = newNode('line', defaultWho(d));
				holder.next = id;
			}, `${d.id}:${id}:L0`);
		} else {
			mutate(() => { holder.next = el.value; });
		}
		Panels.onStructure();
	};
	const next = holder.next;
	if (next !== 'end' && next !== 'back' && d.nodes[next]) {
		if (seen.has(next)) {
			return h('div', {class: 'after'}, t('Then:'), el, h('button', {class: 'jump', onclick: () => flashNode(next)}, t('go to block {id}', {id: next})));
		}
		return [h('div', {class: 'after'}, t('Then:'), el), renderNode(d, next, seen)];
	}
	return h('div', {class: 'after' + (next === 'end' ? ' end' : '')}, t('Then:'), el);
}

function nodeLabel(d, id) {
	const n = d.nodes[id];
	const first = n.lines.find(l => l.text.trim());
	const text = first ? `${charName(first.who)}: ${first.text}` : t('(no text)');
	return `${id} · ${text.length > 44 ? text.slice(0, 44) + '…' : text}`;
}

function flashNode(id) {
	const el = document.querySelector(`#main [data-node="${id}"]`);
	if (!el) return;
	el.scrollIntoView({block: 'center', behavior: 'smooth'});
	el.classList.remove('flash');
	void el.offsetWidth;
	el.classList.add('flash');
}

// ---------------------------------------------------------------- conditions and effects

function addCondButton(list, d, label, inGive) {
	return h('button', {
		class: 'add', title: t('A condition: a stat, a flag, the day, the hour, the place…'),
		onclick: () => mutate(() => list.push(newCond(defaultCondType(S.data, d.character, inGive), S.data, d.character))),
	}, label);
}

function addEffectButton(list, d, label, title) {
	return h('button', {class: 'add', title, onclick: () => mutate(() => list.push(newEffect(defaultEffectType(S.data, d.character), S.data, d.character)))}, label);
}

function opSelect(obj) {
	return selectField(obj, 'op', Object.entries(OPS));
}

// A note where a condition or effect needs something the project doesn't have yet.
function needs(list, text) {
	if (list.length) return null;
	return h('button', {class: 'needs', onclick: () => { S.view = 'project'; render(); }}, text);
}

function renderConds(list, d, tag, inGive) {
	if (!list.length) return null;
	return h('div', {class: 'sub'}, list.map((c, i) => {
		const type = h('select', null, COND_GROUPS.map(([group, types]) => h('optgroup', {label: t(group)}, types.map(([v, l]) => h('option', {value: v}, t(l))))));
		if (!R.CONDITIONS[c.type]) type.append(h('option', {value: c.type}, '⚠ ' + c.type));
		type.value = c.type;
		type.onchange = () => mutate(() => { list[i] = newCond(type.value, S.data, d.character); });
		return h('div', {class: 'rule'}, h('span', {class: 'tag'}, tag), type, condParams(c, d),
			h('button', {class: 'ghost', title: t('Remove'), onclick: () => mutate(() => list.splice(i, 1))}, '×'));
	}));
}

function statSelect(obj, d) {
	return listSelect(obj, 'stat', S.data.stats, undefined, () => {
		if (isGlobal(S.data, obj.stat)) delete obj.who;
		else if (obj.type === 'stat' && !obj.who) obj.who = ownerOrFirst(S.data, d.character);
	});
}

function relationStatSelect(obj) {
	return listSelect(obj, 'stat', charStats(S.data));
}

function hourInput(obj, key) {
	return numField(obj, key, {min: 0, max: 23, class: 'hour'});
}

function condParams(c, d) {
	const p = S.data;
	switch (c.type) {
		case 'stat': return p.stats.length
			? [statSelect(c, d), !isGlobal(p, c.stat) ? [t('of'), charSelect(c, 'who', {player: false})] : null, opSelect(c), numField(c, 'value')]
			: needs(p.stats, t('Add stats in the project setup'));
		case 'relation': return charStats(p).length
			? [relationStatSelect(c), t('of'), charSelect(c, 'from', {player: false}), t('towards'), charSelect(c, 'to', {player: false, except: c.from}), opSelect(c), numField(c, 'value')]
			: needs([], t('Add per-character stats in the project setup'));
		case 'flag': return [inputField(c, 'name', {class: 'flag', list: 'dl-flags', placeholder: t('flag_name')}), boolSelect(c, 'value', t('is on'), t('is off'))];
		case 'item': return p.items.length ? [listSelect(c, 'item', p.items), opSelect(c), numField(c, 'value')] : needs(p.items, t('Add items in the project setup'));
		case 'day': return [opSelect(c), numField(c, 'value', {min: 1})];
		case 'weekday': return p.time.weekdays.length ? chipPicker(c.is, p.time.weekdays, t('+ day')) : needs(p.time.weekdays, t('Add the days of the week in the project setup'));
		case 'phase': return p.time.phases.length ? chipPicker(c.is, p.time.phases, t('+ part of the day')) : needs(p.time.phases, t('Add parts of the day in the project setup'));
		case 'hour': return [t('from'), hourInput(c, 'from'), t('to'), hourInput(c, 'to'), h('span', {class: 'dim tiny'}, c.from > c.to ? t('(past midnight)') : '')];
		case 'place': return p.places.length ? chipPicker(c.is, p.places, t('+ place')) : needs(p.places, t('Add places in the project setup'));
		case 'seen': return [dialogueSelect(c), boolSelect(c, 'value', t('was seen'), t('not seen yet'))];
		case 'given': case 'given_not': return p.items.length ? chipPicker(c.is, p.items, t('+ item')) : needs(p.items, t('Add items in the project setup'));
		case 'given_tag': {
			const tags = allTags(p).map(x => ({id: x, name: x}));
			return tags.length ? chipPicker(c.tags, tags, t('+ tag')) : needs([], t('Give your items tags in the project setup'));
		}
	}
	return null;
}

function dialogueSelect(c) {
	const el = h('select', null, h('option', {value: ''}, t('— which talk —')),
		chars().map(ch => dlgsOf(ch.id).length ? h('optgroup', {label: ch.name}, dlgsOf(ch.id).map(d => h('option', {value: d.id}, d.title || d.id))) : null));
	el.value = c.dialogue;
	el.onchange = () => mutate(() => { c.dialogue = el.value; });
	return el;
}

// `hideOwner`: an option's own stat changes are shown as steppers, so not here too.
function renderEffects(list, d, hideOwner) {
	const shown = list.map((e, i) => [e, i]).filter(([e]) => !(hideOwner && e.type === 'stat' && (e.who || hideOwner) === hideOwner && !isGlobal(S.data, e.stat) && S.data.stats.some(s => s.id === e.stat)));
	if (!shown.length) return null;
	return h('div', {class: 'sub'}, shown.map(([e, i]) => {
		const type = h('select', null, EFFECT_TYPES.map(([v, l]) => h('option', {value: v}, t(l))));
		type.value = e.type;
		type.onchange = () => mutate(() => { list[i] = newEffect(type.value, S.data, d.character); });
		return h('div', {class: 'rule effect'}, h('span', {class: 'tag'}, t('Also')), type, effectParams(e, d),
			h('button', {class: 'ghost', title: t('Remove'), onclick: () => mutate(() => list.splice(i, 1))}, '×'));
	}));
}

function deltaField(e) {
	return h('span', {class: 'stepper ' + (e.delta > 0 ? 'plus' : e.delta < 0 ? 'minus' : '')},
		h('button', {onclick: () => mutate(() => { e.delta = (e.delta || 0) - 1; })}, '−'),
		h('output', null, signed(e.delta || 0)),
		h('button', {onclick: () => mutate(() => { e.delta = (e.delta || 0) + 1; })}, '+'));
}

function effectParams(e, d) {
	const p = S.data;
	switch (e.type) {
		case 'stat': return p.stats.length
			? [statSelect(e, d), !isGlobal(p, e.stat) ? [t('of'), charSelect(e, 'who', {player: false})] : null, deltaField(e)]
			: needs(p.stats, t('Add stats in the project setup'));
		case 'relation': return charStats(p).length
			? [relationStatSelect(e), t('of'), charSelect(e, 'from', {player: false}), t('towards'), charSelect(e, 'to', {player: false, except: e.from}), deltaField(e)]
			: needs([], t('Add per-character stats in the project setup'));
		case 'flag': return [inputField(e, 'name', {class: 'flag', list: 'dl-flags', placeholder: t('flag_name')}, drawDatalists), boolSelect(e, 'value', t('on'), t('off'))];
		case 'item': return p.items.length ? [listSelect(e, 'item', p.items), deltaField(e)] : needs(p.items, t('Add items in the project setup'));
		case 'time': return [numField(e, 'amount', {min: 0}), selectField(e, 'unit', [['hours', t('hours')], ['phases', t('parts of the day')], ['days', t('days')]])];
		case 'place': return p.places.length ? listSelect(e, 'place', p.places) : needs(p.places, t('Add places in the project setup'));
		case 'event': return [inputField(e, 'name', {class: 'flag', placeholder: t('event_name'), title: t('The name the game knows it by')}),
			inputField(e, 'text', {class: 'text', placeholder: t('What has to happen, in words (music changes, a shop opens…)')})];
	}
	return null;
}

function drawDatalists() {
	document.getElementById('dl-flags').replaceChildren(...allFlags(S.data).map(f => h('option', {value: f})));
	document.getElementById('dl-groups').replaceChildren(...[...new Set(chars().map(c => c.group))].map(g => h('option', {value: g})));
}

// ---------------------------------------------------------------- a character's sheet

function renderCharacter(c) {
	const isPlayer = c.id === PLAYER;
	const used = dlgsOf(c.id).length;
	const stats = charStats(S.data);
	const charIds = () => {
		const s = new Set(chars().map(x => x.id));
		s.add(NARRATOR);
		return s;
	};
	const nameEl = inputField(c, 'name', {class: 'name', 'data-fk': 'char-name'}, renderSide);
	nameFollows(nameEl, 'character', c, charIds, () => c.name, (from, to) => { S.charId = to; });
	return h('div', {class: 'sheet'},
		h('div', {class: 'sheet-row'},
			h('input', {type: 'color', value: c.color, title: t('Their color'), onchange: e => mutate(() => { c.color = e.target.value; })}),
			nameEl,
			h('label', null, t('Group'), inputField(c, 'group', {list: 'dl-groups', style: 'width:130px'}, renderSide)),
			isPlayer ? h('span', {class: 'mono'}, c.id) : h('label', {class: 'dim tiny'}, 'id', idField('character', c, () => { const s = charIds(); s.delete(c.id); return s; }, (from, to) => { S.charId = to; })),
			h('span', {class: 'grow'}),
			used ? h('button', {onclick: () => selectDlg(dlgsOf(c.id)[0].id)}, t('See their {n} talks', {n: used})) : null,
			!isPlayer ? h('button', {class: 'danger', disabled: used > 0, title: used ? t('They have talks: delete or move those first') : '', onclick: () => deleteChar(c)}, t('Delete')) : null,
		),
		h('section', null,
			h('h3', null, isPlayer ? t('The player') : t('Who they are')),
			isPlayer ? h('div', {class: 'dim tiny', style: 'margin-bottom:6px'}, t('Their name is what the player is called in the talks ({player} in a line).')) : null,
			textField(c, 'notes', {placeholder: t('Who they are, how they talk, what they hide…')})),
		h('section', null,
			h('h3', null, t('Moods')),
			h('div', {class: 'dim tiny', style: 'margin-bottom:6px'}, t('The faces or tones a line can have (the game picks the portrait or the voice).')),
			wordChips(c.moods, t('happy, sad, angry…'))),
		!isPlayer && stats.length ? h('section', null,
			h('h3', null, t('Where their stats start')),
			h('div', {class: 'stat-starts'}, stats.map(s => h('label', {style: `--c:${s.color}`}, h('span', {class: 'stat-name'}, s.name),
				numField(c.stats, s.id, {placeholder: String(s.start)}))))) : null,
		!isPlayer && S.data.items.length ? h('section', null,
			h('h3', null, t('Likes and dislikes')),
			h('div', {class: 'dim tiny', style: 'margin-bottom:6px'}, t('For the conditions “Gave something they like” and “…they dislike”.')),
			h('div', {class: 'likes'}, h('span', {class: 'dim'}, t('Likes')), chipPicker(c.likes, S.data.items, '+ ' + t('item'))),
			h('div', {class: 'likes'}, h('span', {class: 'dim'}, t('Dislikes')), chipPicker(c.dislikes, S.data.items, '+ ' + t('item')))) : null,
		!isPlayer ? renderRelations(c, stats) : null,
	);
}

function renderRelations(c, stats) {
	const others = npcs(S.data).filter(o => o.id !== c.id);
	return h('section', null,
		h('h3', null, t('How they see other characters')),
		h('div', {class: 'dim tiny', style: 'margin-bottom:6px'}, stats.length
			? t('The numbers are where the stats start between the two; talks change them with “Also…” and ask about them with “Only if…”.')
			: t('Notes on how they get on. Add per-character stats in the project setup to give them numbers.')),
		c.relations.length ? h('div', {class: 'rel-row rel-head', style: `--n:${stats.length}`}, h('span', null, t('Who')), h('span', null, t('What they are to them')), stats.map(s => h('span', null, s.name)), h('span')) : null,
		c.relations.map((r, i) => h('div', {class: 'rel-row', style: `--n:${stats.length}`},
			charSelect(r, 'to', {player: false, except: c.id}),
			inputField(r, 'label', {placeholder: t('her boss, they don\'t talk, owes him money…')}),
			stats.map(s => numField(r.values, s.id, {placeholder: String(s.start)})),
			h('button', {class: 'ghost', title: t('Remove'), onclick: () => mutate(() => c.relations.splice(i, 1))}, '×'))),
		others.length ? h('div', {class: 'add-row'}, h('button', {
			class: 'add',
			onclick: () => mutate(() => {
				const free = others.find(o => !c.relations.some(r => r.to === o.id)) || others[0];
				c.relations.push({to: free.id, label: '', values: {}});
			}),
		}, '+ ' + t('Relation'))) : h('div', {class: 'dim tiny'}, t('Add another character first.')),
	);
}

function deleteChar(c) {
	const refs = countRefs(S.data, 'character', c.id);
	if (!confirm(refs ? t('Delete {name}? Other talks name them {n} times: those show up in Review.', {name: c.name, n: refs}) : t('Delete {name}?', {name: c.name}))) return;
	mutate(() => {
		chars().splice(chars().indexOf(c), 1);
		for (const o of chars()) o.relations = o.relations.filter(r => r.to !== c.id);
		S.charId = (npcs(S.data)[0] || chars()[0]).id;
		S.view = 'dialogue';
		S.dlgId = (dlgsOf(S.charId)[0] || {id: null}).id;
	});
	Panels.onStructure();
}

// ---------------------------------------------------------------- it all

function render() {
	document.documentElement.lang = I18N.lang;
	document.title = (S.data.title ? S.data.title + ' · ' : '') + 'Dialogos';
	renderTop();
	renderSide();
	renderMain();
	drawDatalists();
	Panels.onStructure();
	if (S.pendingFocus) {
		const el = document.querySelector(`[data-fk="${S.pendingFocus}"]`);
		S.pendingFocus = null;
		if (el) el.focus();
	}
}

async function start() {
	initLanguage();
	try {
		const th = localStorage.getItem('dialogos.theme');
		if (th && th !== 'auto') document.documentElement.dataset.theme = th;
		if (localStorage.getItem('dialogos.noPanel')) document.getElementById('app').classList.add('no-panel');
	} catch (e) { /* (only preferences) */ }
	let doc = null;
	try {
		S.store = await ServerStore.detect();
		if (S.store) {
			doc = await S.store.load();
		} else {
			S.store = new BrowserStore();
			doc = S.store.load();
		}
		S.data = doc ? normalizeProject(doc) : newProject(I18N.lang);
	} catch (e) {
		document.getElementById('main').replaceChildren(h('div', {class: 'empty'}, h('h2', null, t('Couldn\'t open the project')), String(e.message || e)));
		return;
	}
	const first = npcs(S.data)[0] || chars()[0];
	S.charId = first.id;
	S.dlgId = (dlgsOf(first.id)[0] || {id: null}).id;
	S.view = projectIsEmpty() ? 'welcome' : 'dialogue';
	if (!doc) {
		S.dirty = true;
		saveNow();
	}
	render();
	// (?example: a link that opens the example, where there's nothing to lose)
	if (new URLSearchParams(location.search).has('example') && S.store.kind === 'browser' && projectIsEmpty()) loadExample(true);
	window.addEventListener('focus', checkDisk);
	window.addEventListener('storage', ev => {
		if (S.store.kind !== 'browser') return;
		const text = S.store.foreignChange(ev);
		if (!text) return;
		if (!S.dirty) reloadFromStore(text);
		else {
			S.conflict = true;
			drawConflict(text);
		}
	});
	window.addEventListener('beforeunload', e => {
		if (S.dirty || S.saving) {
			saveNow();
			e.preventDefault();
		}
	});
	document.addEventListener('click', e => {
		for (const m of document.querySelectorAll('details.menu[open]')) if (!m.contains(e.target)) m.open = false;
	});
	window.addEventListener('keydown', e => {
		const typing = ['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName);
		const k = e.key.toLowerCase();
		if ((e.ctrlKey || e.metaKey) && k === 's') {
			e.preventDefault();
			saveNow();
		} else if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y') && !typing) {
			e.preventDefault();
			(k === 'y' || e.shiftKey) ? travel(S.redo, S.undo) : travel(S.undo, S.redo);
		}
	});
}

window.addEventListener('DOMContentLoaded', start);
