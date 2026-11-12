'use strict';
// What the editor knows about a project, with no page in it: the defaults every field gets, what
// goes to disk, conditions and effects in words, and what's wrong with a talk. (The format itself
// is told in docs/FORMAT.md; how it runs, in runtime.js.)

const R = DialogosRuntime;
const PLAYER = R.PLAYER;
const NARRATOR = R.NARRATOR;
const OPS = {'>=': '≥', '<=': '≤', '==': '=', '!=': '≠', '>': '>', '<': '<'};
const PALETTE = ['#ff7a59', '#7ddc6f', '#c79bff', '#5fd4c4', '#ff9fd2', '#9fb6ff', '#e6d36a', '#6fb7ff', '#ffa94d', '#b3e05a'];

// [group, [[type, label]]]: labels go through t() when shown.
const COND_GROUPS = [
	['Stats', [['stat', 'A stat'], ['relation', 'How two characters get on']]],
	['Story', [['flag', 'A flag'], ['seen', 'A talk was seen (or not)'], ['item', 'The player has an item']]],
	['Time and place', [['day', 'Day number'], ['weekday', 'Day of the week'], ['phase', 'Part of the day'], ['hour', 'Hour'], ['place', 'Place']]],
	['What the player gave', [['given', 'Gave one of…'], ['given_not', 'Gave something, but not…'], ['given_tag', 'Gave something tagged…'],
		['given_liked', 'Gave something they like'], ['given_disliked', 'Gave something they dislike'], ['given_asked', 'Gave what they asked for'], ['given_none', 'Gave nothing']]],
];
const EFFECT_TYPES = [['stat', 'Change a stat'], ['relation', 'Change how two characters get on'], ['flag', 'Turn a flag on or off'],
	['item', 'Give or take an item'], ['time', 'Time goes by'], ['place', 'Go to a place'], ['event', 'Something for the game to do']];
const MODES = [
	['choice', 'Player chooses', 'The player answers with one of the options'],
	['give', 'Gets an item', 'Waits for the player to give or show an item; what follows depends on which'],
	['branch', 'Depends on…', 'No choice: the first branch whose conditions hold'],
	['random', 'At random', 'One at random, of those whose conditions hold'],
	['line', 'Goes on or ends', 'No branches'],
];
const NUMBER_CONDS = ['stat', 'relation', 'item', 'day'];
const GIVEN_CONDS = ['given', 'given_not', 'given_tag', 'given_liked', 'given_disliked', 'given_asked', 'given_none'];

const arr = v => Array.isArray(v) ? v : [];
const num = (v, d) => typeof v === 'number' && isFinite(v) ? v : d;
const clone = x => JSON.parse(JSON.stringify(x));
const charStats = p => p.stats.filter(s => s.scope !== 'global');
const npcs = p => p.characters.filter(c => c.id !== PLAYER);
const isGlobal = (p, statId) => (p.stats.find(s => s.id === statId) || {}).scope === 'global';
const ownerOrFirst = (p, owner) => owner && owner !== PLAYER ? owner : ((npcs(p)[0] || {}).id || '');
const otherThan = (p, id) => ((npcs(p).find(c => c.id !== id) || npcs(p)[0] || {}).id || '');

function slug(text) {
	return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
		.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function nextFreeId(prefix, taken) {
	let i = 1;
	while (taken.has(prefix + i)) i++;
	return prefix + i;
}

// An id for a new thing named `name`, not taken yet.
function idFor(name, taken, fallback) {
	const base = slug(name) || fallback;
	if (!taken.has(base)) return base;
	return nextFreeId(base + '_', taken);
}

// ---------------------------------------------------------------- a new project

function phasePreset() {
	return [
		{id: 'morning', name: t('Morning'), start: 6},
		{id: 'afternoon', name: t('Afternoon'), start: 12},
		{id: 'evening', name: t('Evening'), start: 18},
		{id: 'night', name: t('Night'), start: 22},
	];
}

function weekdayPreset() {
	return [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']]
		.map(([id, name]) => ({id, name: t(name)}));
}

// Stats a click away on the setup page.
function statPresets() {
	return [
		{id: 'trust', name: t('Trust'), scope: 'character', min: 0, max: 10, start: 0, color: '#5fd4c4'},
		{id: 'romance', name: t('Romance'), scope: 'character', min: 0, max: 10, start: 0, color: '#ff6fa8'},
		{id: 'friendship', name: t('Friendship'), scope: 'character', min: 0, max: 10, start: 0, color: '#7ddc6f'},
		{id: 'fear', name: t('Fear'), scope: 'character', min: 0, max: 10, start: 0, color: '#c79bff'},
		{id: 'money', name: t('Money'), scope: 'global', min: 0, max: null, start: 0, color: '#e6d36a'},
		{id: 'reputation', name: t('Reputation'), scope: 'global', min: null, max: null, start: 0, color: '#ffa94d'},
	];
}

// The empty model: the player, the parts of a day, nothing else.
function newProject(lang) {
	return normalizeProject({
		format: 'dialogos', version: R.FORMAT_VERSION, title: t('My project'), lang,
		time: {start: {day: 1, hour: 8}, phases: phasePreset(), weekdays: []},
		characters: [{id: PLAYER, name: t('Player'), group: t('Player'), color: '#ffb838', notes: t('The player. What they say is mostly the options they pick.')}],
	});
}

// ---------------------------------------------------------------- every field the editor counts on

function normalizeProject(p) {
	p.format = 'dialogos';
	p.version = R.FORMAT_VERSION;
	p.title = p.title || '';
	p.lang = p.lang || 'en';
	p.stats = arr(p.stats);
	for (const s of p.stats) {
		s.name = s.name || s.id;
		s.scope = s.scope === 'global' ? 'global' : 'character';
		s.min = num(s.min, null);
		s.max = num(s.max, null);
		s.start = num(s.start, 0);
		s.color = s.color || '#9fb6ff';
		s.notes = s.notes || '';
	}
	p.time = p.time || {};
	p.time.start = p.time.start || {};
	p.time.start.day = num(p.time.start.day, 1);
	p.time.start.hour = num(p.time.start.hour, null);
	p.time.start.place = p.time.start.place || '';
	p.time.phases = arr(p.time.phases);
	for (const ph of p.time.phases) {
		ph.name = ph.name || ph.id;
		ph.start = num(ph.start, 0);
	}
	p.time.weekdays = arr(p.time.weekdays);
	for (const w of p.time.weekdays) w.name = w.name || w.id;
	p.places = arr(p.places);
	for (const pl of p.places) {
		pl.name = pl.name || pl.id;
		pl.notes = pl.notes || '';
	}
	p.items = arr(p.items);
	for (const it of p.items) {
		it.name = it.name || it.id;
		it.tags = arr(it.tags);
		it.start = num(it.start, 0);
		it.notes = it.notes || '';
	}
	p.flags = arr(p.flags);
	for (const f of p.flags) {
		f.start = !!f.start;
		f.notes = f.notes || '';
	}
	const lim = p.limits || {};
	p.limits = {lineChars: num(lim.lineChars, 0), optionChars: num(lim.optionChars, 0), options: num(lim.options, 0)};
	p.characters = arr(p.characters);
	if (!p.characters.some(c => c.id === PLAYER)) {
		p.characters.unshift({id: PLAYER, name: t('Player'), group: t('Player'), color: '#ffb838'});
	}
	p.characters.forEach((c, i) => {
		c.name = c.name || c.id;
		c.group = c.group || t('Characters');
		c.color = c.color || PALETTE[i % PALETTE.length];
		c.notes = c.notes || '';
		c.moods = arr(c.moods);
		c.stats = c.stats && typeof c.stats === 'object' ? c.stats : {};
		c.likes = arr(c.likes);
		c.dislikes = arr(c.dislikes);
		c.relations = arr(c.relations);
		for (const r of c.relations) {
			r.label = r.label || '';
			r.values = r.values && typeof r.values === 'object' ? r.values : {};
		}
	});
	p.dialogues = arr(p.dialogues);
	for (const d of p.dialogues) {
		d.title = d.title || '';
		d.status = d.status === 'ready' ? 'ready' : 'draft';
		d.places = arr(d.places);
		d.required = !!d.required;
		d.repeat = !!d.repeat;
		d.if = arr(d.if);
		d.notes = d.notes || '';
		d.nodes = d.nodes && typeof d.nodes === 'object' ? d.nodes : {};
		for (const n of Object.values(d.nodes)) normalizeNode(n);
		if (!d.start || !d.nodes[d.start]) d.start = Object.keys(d.nodes)[0] || '';
	}
	return p;
}

function normalizeNode(n) {
	n.lines = arr(n.lines);
	for (const l of n.lines) l.text = l.text || '';
	n.effects = arr(n.effects);
	n.mode = MODES.some(m => m[0] === n.mode) ? n.mode : 'line';
	n.next = n.next || 'end';
	n.options = arr(n.options);
	n.ask = n.ask || {};
	n.ask.item = n.ask.item || '';
	n.ask.text = n.ask.text || '';
	for (const o of n.options) normalizeOption(o);
	return n;
}

function normalizeOption(o) {
	o.text = o.text || '';
	o.if = arr(o.if);
	o.effects = arr(o.effects);
	o.reply = arr(o.reply);
	for (const l of o.reply) l.text = l.text || '';
	o.next = o.next || 'end';
	return o;
}

// ---------------------------------------------------------------- what goes to disk

// Nothing that says nothing, each thing's keys in the order they're read.
function pruneProject(doc) {
	const out = clone(doc);
	const empty = v => v === null || v === undefined || v === '' || v === false || (Array.isArray(v) && !v.length)
		|| (typeof v === 'object' && !Array.isArray(v) && v !== null && !Object.keys(v).length);
	const drop = (o, keys) => {
		for (const k of keys) if (empty(o[k])) delete o[k];
		return o;
	};
	const inOrder = (o, keys) => {
		const copy = {};
		for (const k of keys) if (k in o) copy[k] = o[k];
		return Object.assign(copy, o);
	};
	const lines = list => list.map(l => inOrder(drop(l, ['mood']), ['who', 'text', 'mood']));
	out.stats = out.stats.map(s => {
		drop(s, ['min', 'max', 'notes']);
		if (!s.start) delete s.start;
		return inOrder(s, ['id', 'name', 'scope', 'min', 'max', 'start', 'color', 'notes']);
	});
	const time = out.time;
	drop(time.start, ['hour', 'place']);
	time.phases = time.phases.map(ph => inOrder(ph, ['id', 'name', 'start']));
	drop(time, ['phases', 'weekdays']);
	out.places = out.places.map(pl => inOrder(drop(pl, ['notes']), ['id', 'name', 'notes']));
	out.items = out.items.map(it => {
		drop(it, ['tags', 'notes']);
		if (!it.start) delete it.start;
		return inOrder(it, ['id', 'name', 'tags', 'start', 'notes']);
	});
	out.flags = out.flags.map(f => inOrder(drop(f, ['start', 'notes']), ['id', 'start', 'notes']));
	for (const k of Object.keys(out.limits)) if (!out.limits[k]) delete out.limits[k];
	drop(out, ['title', 'stats', 'places', 'items', 'flags', 'limits']);
	out.characters = out.characters.map(c => {
		for (const k of Object.keys(c.stats)) if (typeof c.stats[k] !== 'number') delete c.stats[k];
		c.relations = c.relations.map(r => inOrder(drop(r, ['label', 'values']), ['to', 'label', 'values']));
		drop(c, ['notes', 'moods', 'stats', 'likes', 'dislikes', 'relations']);
		return inOrder(c, ['id', 'name', 'group', 'color', 'notes', 'moods', 'stats', 'likes', 'dislikes', 'relations']);
	});
	out.dialogues = out.dialogues.map(d => {
		drop(d, ['places', 'required', 'repeat', 'if', 'notes']);
		for (const [id, n] of Object.entries(d.nodes)) {
			if (n.mode === 'line') delete n.options;
			else delete n.next;
			if (n.mode !== 'give') delete n.ask;
			else drop(n.ask, ['item', 'text']);
			n.lines = lines(n.lines);
			if (n.ask) drop(n, ['ask']);
			drop(n, ['lines', 'effects', 'options']);
			if (n.options) {
				n.options = n.options.map(o => {
					o.reply = lines(o.reply);
					drop(o, ['text', 'if', 'effects', 'reply']);
					return inOrder(o, ['id', 'text', 'if', 'effects', 'reply', 'next']);
				});
			}
			d.nodes[id] = inOrder(n, ['lines', 'effects', 'mode', 'ask', 'options', 'next']);
		}
		return inOrder(d, ['id', 'character', 'title', 'status', 'places', 'required', 'repeat', 'if', 'notes', 'start', 'nodes']);
	});
	return inOrder(out, ['format', 'version', 'title', 'lang', 'stats', 'time', 'places', 'items', 'flags', 'limits', 'characters', 'dialogues']);
}

const _scalar = v => v === null || typeof v !== 'object';
function _flat(v) {
	if (Array.isArray(v)) return v.every(_scalar);
	if (v && typeof v === 'object') return Object.values(v).every(x => _scalar(x) || (Array.isArray(x) && x.every(_scalar)));
	return true;
}
function _oneLine(v) {
	if (Array.isArray(v)) return '[' + v.map(_oneLine).join(', ') + ']';
	if (v && typeof v === 'object') return '{' + Object.entries(v).map(([k, x]) => JSON.stringify(k) + ': ' + _oneLine(x)).join(', ') + '}';
	return JSON.stringify(v);
}

// JSON a person can read and diff: each line of a talk, each condition and effect on a line of its
// own. (dialogos.py writes the same, byte for byte.)
function prettyJSON(v, depth = 0) {
	if (_flat(v)) return _oneLine(v);
	const pad = '\t'.repeat(depth + 1);
	const close = '\t'.repeat(depth);
	if (Array.isArray(v)) return '[\n' + v.map(x => pad + prettyJSON(x, depth + 1)).join(',\n') + '\n' + close + ']';
	return '{\n' + Object.entries(v).map(([k, x]) => pad + JSON.stringify(k) + ': ' + prettyJSON(x, depth + 1)).join(',\n') + '\n' + close + '}';
}

const fileText = doc => prettyJSON(pruneProject(doc)) + '\n';

// ---------------------------------------------------------------- new pieces

function newCond(type, p, owner) {
	switch (type) {
		case 'stat': {
			const s = (owner !== PLAYER && charStats(p)[0]) || p.stats[0];
			const c = {type, stat: s ? s.id : '', op: '>=', value: 1};
			if (!s || s.scope !== 'global') c.who = ownerOrFirst(p, owner);
			return c;
		}
		case 'relation': {
			const s = charStats(p)[0];
			const from = ownerOrFirst(p, owner);
			return {type, stat: s ? s.id : '', from, to: otherThan(p, from), op: '>=', value: 1};
		}
		case 'flag': return {type, name: '', value: true};
		case 'item': return {type, item: (p.items[0] || {}).id || '', op: '>=', value: 1};
		case 'day': return {type, op: '>=', value: 2};
		case 'hour': return {type, from: 18, to: 22};
		case 'seen': return {type, dialogue: '', value: true};
		case 'given_tag': return {type, tags: []};
		case 'weekday': case 'phase': case 'place': case 'given': case 'given_not': return {type, is: []};
		default: return {type};
	}
}

function defaultCondType(p, owner, inGive) {
	if (inGive && p.items.length) return 'given';
	if (p.stats.length && (owner !== PLAYER || p.stats.some(s => s.scope === 'global'))) return 'stat';
	if (p.time.phases.length) return 'phase';
	return 'flag';
}

function newEffect(type, p, owner) {
	switch (type) {
		case 'stat': {
			const s = (owner !== PLAYER && charStats(p)[0]) || p.stats[0];
			const e = {type, stat: s ? s.id : '', delta: 1};
			if (!s || s.scope !== 'global') e.who = ownerOrFirst(p, owner);
			return e;
		}
		case 'relation': {
			const s = charStats(p)[0];
			const from = ownerOrFirst(p, owner);
			return {type, stat: s ? s.id : '', from, to: otherThan(p, from), delta: 1};
		}
		case 'flag': return {type, name: '', value: true};
		case 'item': return {type, item: (p.items[0] || {}).id || '', delta: 1};
		case 'time': return {type, unit: 'hours', amount: 1};
		case 'place': return {type, place: (p.places[0] || {}).id || ''};
		default: return {type: 'event', name: '', text: ''};
	}
}

function defaultEffectType(p, owner) {
	if (p.stats.length && (owner !== PLAYER || p.stats.some(s => s.scope === 'global'))) return 'stat';
	return 'flag';
}

function newNode(mode, who) {
	return normalizeNode({lines: [{who, text: ''}], mode, next: 'end', options: []});
}

function newOption(d) {
	const taken = new Set();
	for (const n of Object.values(d.nodes)) for (const o of n.options) taken.add(o.id);
	return normalizeOption({id: nextFreeId('o', taken)});
}

// Who says a talk's lines unless told otherwise: its character, or the narrator in the player's own.
const defaultWho = d => d.character === PLAYER ? NARRATOR : d.character;

// ---------------------------------------------------------------- the shape of a talk

function nodeNexts(n) {
	if (n.mode === 'line') return n.next && n.next !== 'end' ? [n.next] : [];
	return n.options.map(o => o.next).filter(x => x !== 'end' && x !== 'back');
}

function reachable(d) {
	const seen = new Set();
	const walk = id => {
		if (seen.has(id) || !d.nodes[id]) return;
		seen.add(id);
		nodeNexts(d.nodes[id]).forEach(walk);
	};
	walk(d.start);
	return seen;
}

// The effects of a node or option on one of its owner's stats.
function statGain(holder, owner, statId) {
	let v = 0;
	for (const e of holder.effects || []) {
		if (e.type === 'stat' && e.stat === statId && (e.who || owner) === owner) v += e.delta || 0;
	}
	return v;
}

// The least and the most a talk can move one of its owner's stats, along any way through it.
function statRange(d, statId) {
	const stack = new Set();
	const walk = id => {
		const n = d.nodes[id];
		if (!n || stack.has(id)) return [0, 0];
		stack.add(id);
		let lo = 0, hi = 0;
		if (n.mode === 'line') {
			[lo, hi] = walk(n.next);
		} else if (n.options.length) {
			// (what comes back to choose again can all be had; of the ways out, one)
			const loops = n.options.filter(o => o.next === 'back');
			const exits = n.options.filter(o => o.next !== 'back');
			for (const o of loops) {
				const g = statGain(o, d.character, statId);
				lo += Math.min(0, g);
				hi += Math.max(0, g);
			}
			if (exits.length) {
				const ways = exits.map(o => {
					const [a, b] = walk(o.next);
					const g = statGain(o, d.character, statId);
					return [a + g, b + g];
				});
				lo += Math.min(...ways.map(w => w[0]));
				hi += Math.max(...ways.map(w => w[1]));
			}
		}
		stack.delete(id);
		const own = statGain(n, d.character, statId);
		return [lo + own, hi + own];
	};
	return walk(d.start);
}

// Every flag named anywhere: declared, set or asked about.
function allFlags(p) {
	const out = new Set(p.flags.map(f => f.id));
	eachRule(p, x => { if (x.type === 'flag' && x.name) out.add(x.name); });
	return [...out].sort();
}

function allTags(p) {
	return [...new Set(p.items.flatMap(i => i.tags))].sort();
}

// Every condition and effect in the project, with the talk it's in.
function eachRule(p, fn) {
	for (const d of p.dialogues) {
		d.if.forEach(x => fn(x, d));
		for (const n of Object.values(d.nodes)) {
			n.effects.forEach(x => fn(x, d));
			for (const o of n.options) {
				o.if.forEach(x => fn(x, d));
				o.effects.forEach(x => fn(x, d));
			}
		}
	}
}

// Every place the project points at a character, stat, item, place, phase, weekday, talk, flag
// or tag: fn(kind, id, set) with `set` to make it point somewhere else. (A flag's own entry in
// the flags list and a thing's own id aren't references.)
function walkRefs(p, fn) {
	const one = (kind, obj, key) => {
		if (obj && obj[key]) fn(kind, obj[key], v => { obj[key] = v; });
	};
	const many = (kind, list) => (list || []).forEach((v, i) => fn(kind, v, x => { list[i] = x; }));
	const keys = (kind, obj) => {
		for (const k of Object.keys(obj || {})) {
			fn(kind, k, x => {
				if (x === k) return;
				obj[x] = obj[k];
				delete obj[k];
			});
		}
	};
	const rule = x => {
		switch (x.type) {
			case 'stat': one('stat', x, 'stat'); one('character', x, 'who'); break;
			case 'relation': one('stat', x, 'stat'); one('character', x, 'from'); one('character', x, 'to'); break;
			case 'flag': one('flag', x, 'name'); break;
			case 'item': one('item', x, 'item'); break;
			case 'weekday': many('weekday', x.is); break;
			case 'phase': many('phase', x.is); break;
			case 'place': if (Array.isArray(x.is)) many('place', x.is); else one('place', x, 'place'); break;
			case 'seen': one('dialogue', x, 'dialogue'); break;
			case 'given': case 'given_not': many('item', x.is); break;
			case 'given_tag': many('tag', x.tags); break;
		}
	};
	const lines = list => list.forEach(l => one('character', l, 'who'));
	one('place', p.time.start, 'place');
	for (const it of p.items) many('tag', it.tags);
	for (const c of p.characters) {
		keys('stat', c.stats);
		many('item', c.likes);
		many('item', c.dislikes);
		for (const r of c.relations) {
			one('character', r, 'to');
			keys('stat', r.values);
		}
	}
	for (const d of p.dialogues) {
		one('character', d, 'character');
		many('place', d.places);
		d.if.forEach(rule);
		for (const n of Object.values(d.nodes)) {
			lines(n.lines);
			n.effects.forEach(rule);
			one('item', n.ask, 'item');
			for (const o of n.options) {
				o.if.forEach(rule);
				o.effects.forEach(rule);
				lines(o.reply);
			}
		}
	}
}

function countRefs(p, kind, id) {
	let n = 0;
	walkRefs(p, (k, v) => { if (k === kind && v === id) n++; });
	return n;
}

function renameRefs(p, kind, from, to) {
	walkRefs(p, (k, v, set) => { if (k === kind && v === from) set(to); });
}

// Every line of text, in reading order: [{key, d, node, kind, who, mood, text}].
function eachText(p, fn) {
	for (const d of p.dialogues) {
		for (const [id, n] of Object.entries(d.nodes)) {
			n.lines.forEach((l, i) => fn({key: `${d.id}/${id}/line${i + 1}`, d, node: id, kind: 'line', who: l.who, mood: l.mood || '', text: l.text}));
			if (n.mode === 'give' && n.ask.text) fn({key: `${d.id}/${id}/ask`, d, node: id, kind: 'ask', who: d.character, mood: '', text: n.ask.text});
			if (n.mode === 'line') continue;
			for (const o of n.options) {
				if (n.mode === 'choice') fn({key: `${d.id}/${id}/${o.id}`, d, node: id, kind: 'option', who: PLAYER, mood: '', text: o.text});
				o.reply.forEach((l, i) => fn({key: `${d.id}/${id}/${o.id}/reply${i + 1}`, d, node: id, kind: 'reply', who: l.who, mood: l.mood || '', text: l.text}));
			}
		}
	}
}

// All the text, for translators and voice actors (Excel reads the accents thanks to the BOM).
function toCSV(p) {
	const cell = v => /[",\n\r]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
	const rows = [['key', 'character', 'dialogue', 'node', 'kind', 'who', 'mood', 'text']];
	eachText(p, x => { if (x.text.trim()) rows.push([x.key, x.d.character, x.d.title, x.node, x.kind, x.who, x.mood, x.text]); });
	return '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- in words

function signed(n) {
	return (n > 0 ? '+' : '') + n;
}

function hh(h) {
	return (h === null || h === undefined || h === '' ? '?' : String(h).padStart(2, '0')) + ':00';
}

// f: how names are put in words (the page gives it: names(), title(), and lists).
function describeCond(c, f) {
	const op = OPS[c.op] || '=';
	switch (c.type) {
		case 'stat': return c.who && !f.isGlobal(c.stat)
			? t('{stat} of {who} {op} {value}', {stat: f.stat(c.stat), who: f.name(c.who), op, value: c.value})
			: t('{stat} {op} {value}', {stat: f.stat(c.stat), op, value: c.value});
		case 'relation': return t('{stat}: {from} → {to} {op} {value}', {stat: f.stat(c.stat), from: f.name(c.from), to: f.name(c.to), op, value: c.value});
		case 'flag': return c.value !== false ? t('flag {name} is on', {name: c.name || '?'}) : t('flag {name} is off', {name: c.name || '?'});
		case 'item': return t('has {op} {value} × {item}', {op: OPS[c.op || '>='], value: num(c.value, 1), item: f.item(c.item)});
		case 'day': return t('day {op} {value}', {op, value: c.value});
		case 'weekday': return t('it is {list}', {list: f.list(c.is, f.weekday)});
		case 'phase': return t('it is {list}', {list: f.list(c.is, f.phase)});
		case 'hour': return t('from {from} to {to}', {from: hh(c.from), to: hh(c.to)});
		case 'place': return t('at {list}', {list: f.list(c.is, f.place)});
		case 'seen': return c.value !== false ? t('“{title}” was seen', {title: f.title(c.dialogue)}) : t('“{title}” not seen yet', {title: f.title(c.dialogue)});
		case 'given': return t('gave {list}', {list: f.list(c.is, f.item)});
		case 'given_not': return t('gave something other than {list}', {list: f.list(c.is, f.item)});
		case 'given_tag': return t('gave something tagged {list}', {list: f.list(c.tags, x => x)});
		case 'given_liked': return t('gave something they like');
		case 'given_disliked': return t('gave something they dislike');
		case 'given_asked': return t('gave what they asked for');
		case 'given_none': return t('gave nothing');
	}
	return c.type;
}

function describeEffect(e, f) {
	switch (e.type) {
		case 'stat': return e.who && !f.isGlobal(e.stat)
			? t('{delta} {stat} of {who}', {delta: signed(e.delta || 0), stat: f.stat(e.stat), who: f.name(e.who)})
			: t('{delta} {stat}', {delta: signed(e.delta || 0), stat: f.stat(e.stat)});
		case 'relation': return t('{delta} {stat}: {from} → {to}', {delta: signed(e.delta || 0), stat: f.stat(e.stat), from: f.name(e.from), to: f.name(e.to)});
		case 'flag': return e.value !== false ? t('flag {name} on', {name: e.name || '?'}) : t('flag {name} off', {name: e.name || '?'});
		case 'item': return (e.delta || 0) >= 0
			? t('the player gets {n} × {item}', {n: e.delta || 0, item: f.item(e.item)})
			: t('the player loses {n} × {item}', {n: -e.delta, item: f.item(e.item)});
		case 'time':
			if (e.unit === 'days') return t('time: +{n} days', {n: e.amount || 0});
			if (e.unit === 'phases') return t('time: on to the next part of the day (×{n})', {n: e.amount || 0});
			return t('time: +{n} h', {n: e.amount || 0});
		case 'place': return t('goes to {place}', {place: f.place(e.place)});
		case 'event': return e.text ? t('event {name}: {text}', {name: e.name || '?', text: e.text}) : t('event {name}', {name: e.name || '?'});
	}
	return e.type;
}

// ---------------------------------------------------------------- what's wrong

// [{level: 'error'|'warn', dlg, node, text}] for the whole project.
function reviewProject(p, f) {
	const out = [];
	const ids = new Set(p.dialogues.map(d => d.id));
	const chars = new Set(p.characters.map(c => c.id));
	const stats = new Map(p.stats.map(s => [s.id, s]));
	const items = new Set(p.items.map(i => i.id));
	const places = new Set(p.places.map(x => x.id));
	const phases = new Set(p.time.phases.map(x => x.id));
	const weekdays = new Set(p.time.weekdays.map(x => x.id));
	const tags = new Set(allTags(p));
	const flagsSet = new Set(p.flags.map(x => x.id));
	const flagsAsked = new Map();
	const lim = p.limits;
	const missing = (list, set) => (list || []).some(x => !set.has(x));

	for (const d of p.dialogues) {
		const add = (level, node, text) => out.push({level, dlg: d.id, node, text});
		const owner = chars.has(d.character) ? p.characters.find(c => c.id === d.character) : null;
		const checkStat = (x, node) => {
			const s = stats.get(x.stat);
			if (!s) return add('error', node, t('A stat that isn\'t in the project: {id}.', {id: x.stat || '?'}));
			if (x.type === 'stat' && s.scope !== 'global' && x.who && !chars.has(x.who)) add('error', node, t('Someone who isn\'t there any more: {id}.', {id: x.who}));
			if (x.type === 'relation') {
				if (s.scope === 'global') add('error', node, t('“{stat}” is global: it can\'t be between two characters.', {stat: s.name}));
				if (!chars.has(x.from) || !chars.has(x.to)) add('error', node, t('Someone who isn\'t there any more: {id}.', {id: !chars.has(x.from) ? x.from : x.to}));
			}
		};
		const checkConds = (list, node, inGive) => {
			for (const c of list) {
				if (NUMBER_CONDS.includes(c.type) && c.type !== 'item' && (c.value === null || c.value === undefined)) add('error', node, t('A condition has no number.'));
				if (c.type === 'stat' || c.type === 'relation') checkStat(c, node);
				else if (c.type === 'item' && !items.has(c.item)) add('error', node, t('A condition names an item that isn\'t in the project.'));
				else if (c.type === 'weekday' && (!c.is.length || missing(c.is, weekdays))) add('error', node, c.is.length ? t('A condition names a weekday that isn\'t in the project.') : t('A weekday condition says no day.'));
				else if (c.type === 'phase' && (!c.is.length || missing(c.is, phases))) add('error', node, c.is.length ? t('A condition names a part of the day that isn\'t in the project.') : t('A part-of-the-day condition says none.'));
				else if (c.type === 'place' && (!c.is.length || missing(c.is, places))) add('error', node, c.is.length ? t('A condition names a place that isn\'t in the project.') : t('A place condition says no place.'));
				else if ((c.type === 'given' || c.type === 'given_not') && (!c.is.length || missing(c.is, items))) add('error', node, c.is.length ? t('A condition names an item that isn\'t in the project.') : t('A condition about what was given says no item.'));
				else if (c.type === 'given_tag' && (!c.tags.length || missing(c.tags, tags))) add('error', node, c.tags.length ? t('A condition names a tag no item has.') : t('A condition about what was given says no tag.'));
				else if (c.type === 'hour' && (c.from === null || c.to === null || c.from === undefined || c.to === undefined)) add('error', node, t('An hour condition is missing an hour.'));
				else if (c.type === 'seen' && !ids.has(c.dialogue)) add('error', node, t('A condition names a talk that isn\'t there.'));
				else if (c.type === 'flag') {
					if (!c.name) add('error', node, t('A flag condition has no name.'));
					else if (!flagsAsked.has(c.name)) flagsAsked.set(c.name, {dlg: d.id, node});
				}
				if (GIVEN_CONDS.includes(c.type) && !inGive) add('warn', node, t('“{cond}” only means something after the player gives an item (a block in “Gets an item” mode).', {cond: describeCond(c, f)}));
				if (!R.CONDITIONS[c.type]) add('error', node, t('A condition of a kind Dialogos doesn\'t know: {id}.', {id: c.type}));
			}
		};
		const checkEffects = (list, node) => {
			for (const e of list) {
				if (e.type === 'stat' || e.type === 'relation') checkStat(e, node);
				else if (e.type === 'item' && !items.has(e.item)) add('error', node, t('An effect names an item that isn\'t in the project.'));
				else if (e.type === 'place' && !places.has(e.place)) add('error', node, t('An effect names a place that isn\'t in the project.'));
				else if (e.type === 'flag') {
					if (e.name) flagsSet.add(e.name);
					else add('error', node, t('A flag effect has no name.'));
				} else if (e.type === 'event' && !e.name) add('warn', node, t('An event has no name for the game to know it by.'));
				else if (e.type === 'time' && e.unit === 'phases' && !phases.size) add('error', node, t('Time goes on by parts of the day, but the project has none.'));
				if ((e.type === 'stat' || e.type === 'relation' || e.type === 'item') && !e.delta) add('warn', node, t('An effect changes nothing (0).'));
			}
		};
		const checkLines = (lines, node) => {
			for (const ln of lines) {
				if (!ln.text.trim()) add('warn', node, t('A line of {who} is empty.', {who: f.name(ln.who)}));
				else if (lim.lineChars && ln.text.length > lim.lineChars) add('warn', node, t('Too long for the text box ({n} characters, {max} fit): “{text}…”', {n: ln.text.length, max: lim.lineChars, text: ln.text.slice(0, 40)}));
				if (ln.who !== NARRATOR && !chars.has(ln.who)) add('error', node, t('A line by someone who isn\'t there any more ({id}).', {id: ln.who}));
				else if (ln.mood) {
					const c = p.characters.find(x => x.id === ln.who);
					if (c && !c.moods.includes(ln.mood)) add('warn', node, t('{who} has no mood “{mood}”.', {who: c.name, mood: ln.mood}));
				}
			}
		};
		if (!d.title.trim()) add('warn', null, t('The talk has no title.'));
		if (!owner) add('error', null, t('It belongs to someone who isn\'t there any more ({id}).', {id: d.character}));
		if (missing(d.places, places)) add('error', null, t('It happens in a place that isn\'t in the project.'));
		if (!d.nodes[d.start]) add('error', null, t('The talk has no first block.'));
		checkConds(d.if, null, false);
		// (blocks after a “Gets an item” one can still ask what was given)
		const afterGive = new Set();
		const walkGive = id => {
			if (afterGive.has(id) || !d.nodes[id]) return;
			afterGive.add(id);
			nodeNexts(d.nodes[id]).forEach(walkGive);
		};
		for (const [id, n] of Object.entries(d.nodes)) if (n.mode === 'give') walkGive(id);
		const reach = reachable(d);
		for (const [id, n] of Object.entries(d.nodes)) {
			if (!reach.has(id)) add('warn', id, t('Loose block: nothing leads here.'));
			checkLines(n.lines, id);
			checkEffects(n.effects, id);
			if (n.mode === 'line') {
				if (n.next !== 'end' && !d.nodes[n.next]) add('error', id, t('It goes on to a block that isn\'t there.'));
				if (!n.lines.length && !n.effects.length) add('warn', id, t('Empty block.'));
				continue;
			}
			if (n.mode === 'give') {
				if (!p.items.length) add('warn', id, t('The block waits for an item, but the project has no items.'));
				if (n.ask.item && !items.has(n.ask.item)) add('error', id, t('It asks for an item that isn\'t in the project.'));
			}
			for (const o of n.options) {
				if (n.mode === 'choice') {
					if (!o.text.trim()) add('warn', id, t('An option of the player is empty.'));
					else if (lim.optionChars && o.text.length > lim.optionChars) add('warn', id, t('Option too long ({n} characters, {max} fit): “{text}…”', {n: o.text.length, max: lim.optionChars, text: o.text.slice(0, 40)}));
				}
				if (o.next !== 'end' && o.next !== 'back' && !d.nodes[o.next]) add('error', id, t('An option goes on to a block that isn\'t there.'));
				if (o.next === 'back' && n.mode !== 'choice') add('error', id, t('“Choose again” only works when the player chooses.'));
				checkConds(o.if, id, afterGive.has(id));
				checkLines(o.reply, id);
				checkEffects(o.effects, id);
			}
			const open = n.options.filter(o => !o.if.length);
			if (n.mode === 'choice') {
				if (!n.options.length) add('error', id, t('The player has to choose and there are no options.'));
				else if (n.options.length === 1 && !open.length) add('warn', id, t('The only option has a condition: if it doesn\'t hold, the talk is stuck.'));
				else if (n.options.length === 1) add('warn', id, t('A single option isn\'t a choice (it\'s a “go on”).'));
				else if (!open.length) add('warn', id, t('Every option has a condition: there may be none left. Leave one free.'));
				if (lim.options && open.length > lim.options) add('warn', id, t('{n} options at once: the text box has room for {max}.', {n: open.length, max: lim.options}));
			} else if (!n.options.length) {
				add('error', id, t('There are no branches.'));
			} else if (!open.length && n.mode !== 'random') {
				add('warn', id, t('No “otherwise”: if no branch holds, nothing is said.'));
			}
		}
	}
	for (const [name, where] of flagsAsked) {
		if (!flagsSet.has(name)) out.push({level: 'warn', dlg: where.dlg, node: where.node, text: t('Nobody turns the flag “{name}” on or off (if the game does, add it to the project\'s flags).', {name})});
	}
	return out;
}
