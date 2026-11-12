/*
 * Dialogos runtime: runs the talks of a Dialogos project (see docs/FORMAT.md).
 * No page and no dependencies, so a game can use it as it is, or read it as the reference
 * when porting the format to another engine. The editor's "Try it" panel runs on it too.
 *
 *   Browser:  <script src="runtime.js"></script>   ->  window.DialogosRuntime
 *   Node:     const Dialogos = require('./runtime.js');
 *
 *   const state = Dialogos.newState(project);
 *   const run = Dialogos.start(project, 'mia_intro', state);
 *   for (let ev = run.next(); ev.type !== 'end'; ev = run.next()) {
 *     if (ev.type === 'line') show(ev.who, run.fill(ev.text));
 *     else if (ev.type === 'choice') run.choose(ev.options[0].id);
 *     else if (ev.type === 'give') run.give('rose');           // or run.give(null)
 *     else if (ev.type === 'effect' && ev.effect.type === 'event') game.handle(ev.effect);
 *   }
 *
 * MIT licence, like the rest of Dialogos.
 */
(function (root, factory) {
	if (typeof module === 'object' && module.exports) module.exports = factory();
	else root.DialogosRuntime = factory();
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	const FORMAT_VERSION = 1;
	const PLAYER = 'player';
	const NARRATOR = 'narrator';
	const END = 'end';
	const BACK = 'back';
	// (a loop of blocks with nothing in them would never give anything back)
	const MAX_SILENT_STEPS = 1000;

	const byId = (list, id) => (list || []).find(x => x && x.id === id);
	const isNum = v => typeof v === 'number' && isFinite(v);

	function compare(a, op, b) {
		switch (op) {
			case '>=': return a >= b;
			case '<=': return a <= b;
			case '>': return a > b;
			case '<': return a < b;
			case '!=': return a !== b;
			default: return a === b;
		}
	}

	// ------------------------------------------------------------ stats

	function statDef(project, id) {
		return byId(project.stats, id);
	}

	function clamp(project, statId, value) {
		const s = statDef(project, statId);
		if (s && isNum(s.min)) value = Math.max(s.min, value);
		if (s && isNum(s.max)) value = Math.min(s.max, value);
		return value;
	}

	// Where a stat starts for someone: their own sheet first, then the stat's.
	function startOf(project, statId, who) {
		const c = who ? byId(project.characters, who) : null;
		if (c && c.stats && isNum(c.stats[statId])) return c.stats[statId];
		const s = statDef(project, statId);
		return s && isNum(s.start) ? s.start : 0;
	}

	function getStat(project, state, statId, who) {
		const s = statDef(project, statId);
		if (s && s.scope === 'global') {
			return isNum(state.globals[statId]) ? state.globals[statId] : startOf(project, statId, null);
		}
		const m = state.stats[statId];
		return m && isNum(m[who]) ? m[who] : startOf(project, statId, who);
	}

	function setStat(project, state, statId, who, value) {
		value = clamp(project, statId, value);
		const s = statDef(project, statId);
		if (s && s.scope === 'global') state.globals[statId] = value;
		else (state.stats[statId] = state.stats[statId] || {})[who] = value;
	}

	function relationStart(project, statId, from, to) {
		const c = byId(project.characters, from);
		const r = c && (c.relations || []).find(x => x.to === to);
		if (r && r.values && isNum(r.values[statId])) return r.values[statId];
		const s = statDef(project, statId);
		return s && isNum(s.start) ? s.start : 0;
	}

	function getRelation(project, state, statId, from, to) {
		const m = state.relations[statId];
		const v = m && m[from + '>' + to];
		return isNum(v) ? v : relationStart(project, statId, from, to);
	}

	function setRelation(project, state, statId, from, to, value) {
		(state.relations[statId] = state.relations[statId] || {})[from + '>' + to] = clamp(project, statId, value);
	}

	// ------------------------------------------------------------ time

	function phasesOf(project) {
		return ((project.time || {}).phases || []).filter(p => isNum(p.start)).slice().sort((a, b) => a.start - b.start);
	}

	// The phase an hour falls in: the last one started by then (before the first, it's still last night's).
	function phaseAt(project, hour) {
		const ps = phasesOf(project);
		if (!ps.length) return '';
		let cur = ps[ps.length - 1];
		for (const p of ps) if (p.start <= hour) cur = p;
		return cur.id;
	}

	// Day 1 is the first weekday on the list.
	function weekdayOf(project, day) {
		const wd = (project.time || {}).weekdays || [];
		if (!wd.length) return '';
		const i = ((Math.floor(day) - 1) % wd.length + wd.length) % wd.length;
		return wd[i].id;
	}

	// From `from` up to (not including) `to`; past midnight when from > to; the whole day when equal.
	function inHours(hour, from, to) {
		if (!isNum(from) || !isNum(to) || from === to) return true;
		return from < to ? hour >= from && hour < to : hour >= from || hour < to;
	}

	// Time only goes forward.
	function advanceTime(project, state, unit, amount) {
		const n = Math.max(0, Math.floor(amount || 0));
		if (unit === 'days') {
			state.day += n;
		} else if (unit === 'phases') {
			const ps = phasesOf(project);
			for (let i = 0; i < n && ps.length; i++) {
				const at = ps.findIndex(p => p.id === phaseAt(project, state.hour));
				const next = ps[(at + 1) % ps.length];
				if (next.start <= state.hour) state.day += 1;
				state.hour = next.start;
			}
		} else {
			const h = state.hour + n;
			state.day += Math.floor(h / 24);
			state.hour = h % 24;
		}
	}

	// ------------------------------------------------------------ the state

	// Everything a project's talks can ask about or change, as the project says it starts.
	function newState(project) {
		const time = project.time || {};
		const start = time.start || {};
		const ps = phasesOf(project);
		const st = {
			stats: {}, globals: {}, relations: {}, flags: {}, items: {}, seen: {},
			day: isNum(start.day) ? start.day : 1,
			hour: isNum(start.hour) ? start.hour : (ps.length ? ps[0].start : 8),
			place: start.place || '',
		};
		for (const s of project.stats || []) {
			if (s.scope === 'global') st.globals[s.id] = isNum(s.start) ? s.start : 0;
			else st.stats[s.id] = {};
		}
		for (const c of project.characters || []) {
			for (const [sid, v] of Object.entries(c.stats || {})) {
				if (st.stats[sid] && isNum(v)) st.stats[sid][c.id] = v;
			}
			for (const r of c.relations || []) {
				for (const [sid, v] of Object.entries(r.values || {})) {
					if (isNum(v)) (st.relations[sid] = st.relations[sid] || {})[c.id + '>' + r.to] = v;
				}
			}
		}
		for (const f of project.flags || []) if (f.start) st.flags[f.id] = true;
		for (const it of project.items || []) if (isNum(it.start) && it.start > 0) st.items[it.id] = it.start;
		return st;
	}

	// ------------------------------------------------------------ conditions

	// x: {project, state, owner, given, asked}. given: undefined before anything was given,
	// null when the player gave nothing, else the item's id.
	const gaveItem = x => typeof x.given === 'string' && x.given !== '';

	const CONDITIONS = {
		stat: (c, x) => compare(getStat(x.project, x.state, c.stat, c.who || x.owner), c.op, c.value),
		relation: (c, x) => compare(getRelation(x.project, x.state, c.stat, c.from, c.to), c.op, c.value),
		flag: (c, x) => !!x.state.flags[c.name] === (c.value !== false),
		item: (c, x) => compare(x.state.items[c.item] || 0, c.op || '>=', isNum(c.value) ? c.value : 1),
		day: (c, x) => compare(x.state.day, c.op, c.value),
		weekday: (c, x) => (c.is || []).includes(weekdayOf(x.project, x.state.day)),
		phase: (c, x) => (c.is || []).includes(phaseAt(x.project, x.state.hour)),
		hour: (c, x) => inHours(x.state.hour, c.from, c.to),
		place: (c, x) => (c.is || []).includes(x.state.place),
		seen: (c, x) => ((x.state.seen[c.dialogue] || 0) > 0) === (c.value !== false),
		given: (c, x) => gaveItem(x) && (c.is || []).includes(x.given),
		given_not: (c, x) => gaveItem(x) && !(c.is || []).includes(x.given),
		given_tag: (c, x) => {
			const it = gaveItem(x) && byId(x.project.items, x.given);
			return !!it && (it.tags || []).some(t => (c.tags || []).includes(t));
		},
		given_liked: (c, x) => {
			const who = byId(x.project.characters, x.owner);
			return gaveItem(x) && !!who && (who.likes || []).includes(x.given);
		},
		given_disliked: (c, x) => {
			const who = byId(x.project.characters, x.owner);
			return gaveItem(x) && !!who && (who.dislikes || []).includes(x.given);
		},
		given_asked: (c, x) => gaveItem(x) && x.given === x.asked,
		given_none: (c, x) => x.given === null,
	};

	// A type nobody knows doesn't hold (the editor's review points it out). A game can add its
	// own types through `x.conditions` ({type: (cond, x) => bool}).
	function holds(cond, x) {
		const own = x.conditions && x.conditions[cond.type];
		const fn = own || CONDITIONS[cond.type];
		return fn ? !!fn(cond, x) : false;
	}

	const allHold = (list, x) => (list || []).every(c => holds(c, x));
	const failing = (list, x) => (list || []).filter(c => !holds(c, x));

	// ------------------------------------------------------------ effects

	// What an effect does to the state. `event` changes nothing: it's for the game to handle.
	function apply(effect, project, state, owner) {
		const e = effect;
		switch (e.type) {
			case 'stat': {
				const who = e.who || owner;
				setStat(project, state, e.stat, who, getStat(project, state, e.stat, who) + (e.delta || 0));
				break;
			}
			case 'relation':
				setRelation(project, state, e.stat, e.from, e.to, getRelation(project, state, e.stat, e.from, e.to) + (e.delta || 0));
				break;
			case 'flag': state.flags[e.name] = e.value !== false; break;
			case 'item': state.items[e.item] = Math.max(0, (state.items[e.item] || 0) + (e.delta || 0)); break;
			case 'time': advanceTime(project, state, e.unit, e.amount); break;
			case 'place': state.place = e.place || ''; break;
		}
	}

	// ------------------------------------------------------------ words

	// {player}: the player's name; {name}: whoever the talk belongs to; {item}: what was given or asked.
	function fill(text, project, x) {
		x = x || {};
		const name = id => (byId(project.characters, id) || {name: id || ''}).name;
		const item = gaveItem(x) ? x.given : x.asked;
		return String(text || '')
			.replace(/\{player\}/g, name(PLAYER))
			.replace(/\{name\}/g, name(x.owner))
			.replace(/\{item\}/g, item ? (byId(project.items, item) || {name: item}).name : '');
	}

	// ------------------------------------------------------------ which talks can start

	// The talks that can start now, in the file's order. q: {character, place, status}.
	function available(project, state, q) {
		q = q || {};
		const place = q.place !== undefined ? q.place : state.place;
		return (project.dialogues || []).filter(d => {
			if (q.character && d.character !== q.character) return false;
			if (q.status && (d.status || 'draft') !== q.status) return false;
			if (!d.repeat && state.seen[d.id]) return false;
			if (d.places && d.places.length && !d.places.includes(place)) return false;
			return allHold(d.if, {project, state, owner: d.character, conditions: q.conditions});
		});
	}

	// ------------------------------------------------------------ running a talk

	class Run {
		constructor(project, dialogue, state, opts) {
			this.project = project;
			this.dialogue = dialogue;
			this.state = state;
			this.opts = opts || {};
			this.random = this.opts.random || Math.random;
			this.pending = [];
			this.wait = null;
			this.cont = null;
			this.done = false;
			this.used = new Set();
			this.given = undefined;
			this.asked = '';
			this.node = null;
			this.silent = 0;
			this.enter(this.opts.node || dialogue.start);
		}

		ctx() {
			return {project: this.project, state: this.state, owner: this.dialogue.character,
				given: this.given, asked: this.asked, conditions: this.opts.conditions};
		}

		fill(text) {
			return fill(text, this.project, this.ctx());
		}

		// The next thing that happens. While a choice or a gift is awaited, the same event again.
		next() {
			for (;;) {
				if (this.pending.length) {
					this.silent = 0;
					return this.pending.shift();
				}
				if (this.wait) return this.waitEvent();
				if (this.done) return {type: 'end', dialogue: this.dialogue.id};
				if (++this.silent > MAX_SILENT_STEPS) {
					this.emit({type: 'stuck', node: this.node, reason: 'loop'});
					this.finish();
					continue;
				}
				const k = this.cont;
				this.cont = null;
				if (k) k();
				else this.finish();
			}
		}

		choose(optionId) {
			if (!this.wait || this.wait.type !== 'choice') throw new Error('Nothing to choose now');
			const n = this.dialogue.nodes[this.wait.node];
			const o = this.visible(n, this.wait.node).find(x => x.id === optionId);
			if (!o) throw new Error('Option ' + optionId + ' is not available');
			this.take(this.wait.node, o);
		}

		// The player gives (or shows) an item: its id, or null for nothing.
		give(itemId) {
			if (!this.wait || this.wait.type !== 'give') throw new Error('Nothing is awaited now');
			const id = this.wait.node;
			this.wait = null;
			this.given = itemId || null;
			this.emit({type: 'given', node: id, item: this.given});
			this.pick(id);
		}

		// -------- inside

		emit(ev) {
			this.pending.push(ev);
		}

		enter(id) {
			const n = this.dialogue.nodes[id];
			if (!n) return this.finish();
			this.node = id;
			// (before its lines, so they can already name what it asks for with {item})
			if (n.mode === 'give') this.asked = (n.ask || {}).item || '';
			this.lines(n.lines, id);
			this.cont = () => {
				this.applyAll(n.effects, id);
				this.decide(id);
			};
		}

		lines(list, node) {
			for (const ln of list || []) {
				if (!ln.text || !String(ln.text).trim()) continue;
				const ev = {type: 'line', node, who: ln.who, text: ln.text};
				if (ln.mood) ev.mood = ln.mood;
				this.emit(ev);
			}
		}

		applyAll(effects, node) {
			for (const e of effects || []) {
				apply(e, this.project, this.state, this.dialogue.character);
				this.emit({type: 'effect', node, effect: e});
			}
		}

		decide(id) {
			const n = this.dialogue.nodes[id];
			const mode = n.mode || 'line';
			if (mode === 'line') return this.go(n.next || END, id);
			if (mode === 'choice') {
				if (!this.visible(n, id).length) {
					this.emit({type: 'stuck', node: id, reason: 'no-options'});
					return this.finish();
				}
				this.wait = {type: 'choice', node: id};
				return;
			}
			if (mode === 'give') {
				this.wait = {type: 'give', node: id};
				return;
			}
			this.pick(id);
		}

		visible(n, id) {
			const x = this.ctx();
			return (n.options || []).filter(o => !this.used.has(id + ':' + o.id) && allHold(o.if, x));
		}

		waitEvent() {
			const id = this.wait.node;
			const n = this.dialogue.nodes[id];
			if (this.wait.type === 'give') {
				const ask = n.ask || {};
				return {type: 'give', node: id, ask: {item: ask.item || '', text: ask.text || ''}};
			}
			const x = this.ctx();
			const open = (n.options || []).filter(o => !this.used.has(id + ':' + o.id));
			return {
				type: 'choice', node: id,
				options: open.filter(o => allHold(o.if, x)).map(o => ({id: o.id, text: o.text || ''})),
				// (what isn't offered now, and why: for testing tools)
				hidden: open.map(o => ({id: o.id, text: o.text || '', failing: failing(o.if, x)})).filter(o => o.failing.length),
			};
		}

		// Branches, random picks and the answer to a gift: the first that holds, or one at random.
		pick(id) {
			const n = this.dialogue.nodes[id];
			const x = this.ctx();
			const ok = (n.options || []).filter(o => allHold(o.if, x));
			if (!ok.length) {
				this.emit({type: 'stuck', node: id, reason: 'no-branch'});
				return this.finish();
			}
			const o = n.mode === 'random' ? ok[Math.min(ok.length - 1, Math.floor(this.random() * ok.length))] : ok[0];
			this.take(id, o);
		}

		take(id, o) {
			const n = this.dialogue.nodes[id];
			this.wait = null;
			this.used.add(id + ':' + o.id);
			if (n.mode === 'choice') this.emit({type: 'chosen', node: id, option: o.id, text: o.text || ''});
			this.applyAll(o.effects, id);
			this.lines(o.reply, id);
			this.cont = () => this.go(o.next || END, id);
		}

		go(next, from) {
			if (next === END) return this.finish();
			if (next === BACK) return this.decide(from);
			this.enter(next);
		}

		finish() {
			if (this.done) return;
			this.done = true;
			this.cont = null;
			this.wait = null;
			this.state.seen[this.dialogue.id] = (this.state.seen[this.dialogue.id] || 0) + 1;
		}
	}

	function start(project, dialogue, state, opts) {
		const d = typeof dialogue === 'string' ? byId(project.dialogues, dialogue) : dialogue;
		if (!d) throw new Error('No dialogue ' + dialogue);
		return new Run(project, d, state || newState(project), opts);
	}

	return {
		FORMAT_VERSION, PLAYER, NARRATOR, END, BACK, CONDITIONS,
		newState, start, available, holds, allHold, failing, apply, fill,
		getStat, setStat, getRelation, setRelation, phaseAt, weekdayOf, inHours, advanceTime, compare,
	};
});
