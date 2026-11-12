'use strict';
// The right side: try a talk as a game would run it (runtime.js), its map, and what's wrong.

const Panels = (() => {
	let tab = 'try';
	let run = null;
	// What each talk's test starts from, kept while the page is open.
	const states = new Map();

	// ------------------------------------------------------------ the tabs

	function draw() {
		const panel = document.getElementById('panel');
		if (!S.data) return;
		const issues = reviewProject(S.data, WORDS);
		const tabs = h('div', {class: 'tabs'},
			tabBtn('try', t('Try it')),
			tabBtn('map', t('Map')),
			h('button', {class: tab === 'review' ? 'on' : '', onclick: () => setTab('review')}, t('Review'), badge(issues)));
		const pane = h('div', {class: 'pane'});
		if (tab === 'try') pane.append(drawTry());
		else if (tab === 'map') pane.append(drawMap());
		else pane.append(drawReview(issues));
		panel.replaceChildren(tabs, pane);
	}

	function badge(issues) {
		if (!issues.length) return null;
		const errors = issues.filter(i => i.level === 'error').length;
		return h('span', {class: 'badge' + (errors ? '' : ' warn')}, issues.length);
	}

	function tabBtn(id, label) {
		return h('button', {class: tab === id ? 'on' : '', onclick: () => setTab(id)}, label);
	}

	function setTab(id) {
		tab = id;
		draw();
	}

	// ------------------------------------------------------------ try it

	function stateFor(d) {
		if (!states.has(d.id)) {
			const st = R.newState(S.data);
			if (d.places.length && !d.places.includes(st.place)) st.place = d.places[0];
			states.set(d.id, st);
		}
		return states.get(d.id);
	}

	function startRun(d, node) {
		const st = clone(stateFor(d));
		run = {dlg: d.id, r: R.start(S.data, d, st, {node}), log: [], current: null, lastLine: null};
		pump();
		draw();
	}

	// Pulls events until something needs the person: a line to read, a choice, an item to give, the end.
	function pump() {
		for (;;) {
			const ev = run.r.next();
			if (ev.type === 'line') {
				run.current = ev;
				run.lastLine = ev;
				run.log.push({who: ev.who, text: run.r.fill(ev.text), mood: ev.mood});
				return;
			}
			if (ev.type === 'effect') {
				run.log.push({sys: describeEffect(ev.effect, WORDS) + valueAfter(ev.effect), minus: (ev.effect.delta || 0) < 0});
				continue;
			}
			if (ev.type === 'chosen') {
				run.log.push({you: run.r.fill(ev.text) || t('(empty option)')});
				continue;
			}
			if (ev.type === 'given') {
				run.log.push({sys: ev.item ? t('You give: {item}', {item: WORDS.item(ev.item)}) : t('You give nothing.')});
				continue;
			}
			if (ev.type === 'stuck') {
				run.log.push({sys: ev.reason === 'no-options' ? t('No option left to pick: the talk ends here.')
					: ev.reason === 'loop' ? t('The blocks go round in a loop with nothing in them: stopped.')
						: t('No branch holds: nothing is said.'), minus: true});
				continue;
			}
			run.current = ev;
			return;
		}
	}

	// ", now 3" after a stat changes.
	function valueAfter(e) {
		const st = run.r.state;
		if (e.type === 'stat') return t(' (now {n})', {n: R.getStat(S.data, st, e.stat, e.who || run.r.dialogue.character)});
		if (e.type === 'relation') return t(' (now {n})', {n: R.getRelation(S.data, st, e.stat, e.from, e.to)});
		if (e.type === 'item') return t(' (now {n})', {n: st.items[e.item] || 0});
		if (e.type === 'time') return ` (${t('day')} ${st.day}, ${hh(st.hour)})`;
		return '';
	}

	function numInput(obj, key, props) {
		return h('input', {
			type: 'number', value: obj[key] === undefined ? 0 : obj[key], ...props,
			oninput: e => { obj[key] = Number(e.target.value) || 0; refreshWarn(); },
		});
	}

	// Who and what this talk asks about or changes, so its starting state can be set.
	function references(d) {
		const out = {stats: new Set(), globals: new Set(), rel: new Set(), flags: new Set(), seen: new Set(), items: new Set()};
		const eat = x => {
			if ((x.type === 'stat') && S.data.stats.some(s => s.id === x.stat)) {
				if (isGlobal(S.data, x.stat)) out.globals.add(x.stat);
				else out.stats.add(x.stat + '|' + (x.who || d.character));
			}
			if (x.type === 'relation') out.rel.add(x.stat + '|' + x.from + '|' + x.to);
			if (x.type === 'flag' && x.name) out.flags.add(x.name);
			if (x.type === 'seen' && x.dialogue) out.seen.add(x.dialogue);
			if (x.type === 'item' && x.item) out.items.add(x.item);
		};
		d.if.forEach(eat);
		for (const n of Object.values(d.nodes)) {
			n.effects.forEach(eat);
			for (const o of n.options) {
				o.if.forEach(eat);
				o.effects.forEach(eat);
			}
		}
		// (the talk's own character: all their stats, asked about or not)
		if (d.character !== PLAYER) for (const s of charStats(S.data)) out.stats.add(s.id + '|' + d.character);
		return out;
	}

	function drawState(d) {
		const st = stateFor(d);
		const p = S.data;
		const refs = references(d);
		const statBox = (sid, who) => {
			const m = st.stats[sid] = st.stats[sid] || {};
			if (m[who] === undefined) m[who] = R.getStat(p, st, sid, who);
			return h('label', null, who === d.character ? WORDS.stat(sid) : `${WORDS.stat(sid)} · ${charName(who)}`, numInput(m, who));
		};
		const phase = h('select', {onchange: e => {
			const ph = p.time.phases.find(x => x.id === e.target.value);
			if (ph) st.hour = ph.start;
			draw();
		}}, p.time.phases.map(ph => h('option', {value: ph.id}, ph.name)));
		phase.value = R.phaseAt(p, st.hour);
		const place = h('select', {onchange: e => { st.place = e.target.value; refreshWarn(); }}, h('option', {value: ''}, '—'), p.places.map(x => h('option', {value: x.id}, x.name)));
		place.value = st.place;
		const weekday = R.weekdayOf(p, st.day);
		const more = [
			...[...refs.globals].map(sid => {
				if (st.globals[sid] === undefined) st.globals[sid] = R.getStat(p, st, sid, null);
				return h('label', null, WORDS.stat(sid), numInput(st.globals, sid));
			}),
			...[...refs.stats].map(k => k.split('|')).filter(([, who]) => who && who !== PLAYER).map(([sid, who]) => statBox(sid, who)),
			...[...refs.rel].map(k => {
				const [sid, from, to] = k.split('|');
				const m = st.relations[sid] = st.relations[sid] || {};
				const key = from + '>' + to;
				if (m[key] === undefined) m[key] = R.getRelation(p, st, sid, from, to);
				return h('label', null, `${WORDS.stat(sid)} · ${charName(from)} → ${charName(to)}`, numInput(m, key));
			}),
			...[...refs.items].map(id => h('label', null, t('Has {item}', {item: WORDS.item(id)}), numInput(st.items, id, {min: 0}))),
			...[...refs.flags].map(name => h('label', {class: 'wide'}, name, h('input', {type: 'checkbox', checked: !!st.flags[name], onchange: e => { st.flags[name] = e.target.checked; refreshWarn(); }}))),
			...[...refs.seen].map(id => h('label', {class: 'wide'}, t('“{title}” was seen', {title: WORDS.title(id)}), h('input', {type: 'checkbox', checked: !!st.seen[id], onchange: e => { st.seen[id] = e.target.checked ? 1 : 0; refreshWarn(); }}))),
		];
		return h('div', null,
			h('div', {class: 'sim-state'},
				h('label', null, t('Day'), h('span', {class: 'day-box'}, weekday ? h('span', {class: 'dim tiny'}, WORDS.weekday(weekday)) : null,
					h('input', {type: 'number', min: 1, value: st.day, oninput: e => { st.day = Number(e.target.value) || 1; draw(); }}))),
				h('label', null, t('Hour'), h('input', {type: 'number', min: 0, max: 23, value: st.hour, oninput: e => { st.hour = Math.max(0, Math.min(23, Number(e.target.value) || 0)); phase.value = R.phaseAt(p, st.hour); refreshWarn(); }})),
				p.time.phases.length ? h('label', null, t('Part of the day'), phase) : null,
				p.places.length ? h('label', null, t('Place'), place) : null),
			more.length ? h('details', {class: 'sim-more', open: true},
				h('summary', null, t('What this talk asks about or changes')),
				h('div', {class: 'sim-state', style: 'margin-top:6px'}, more)) : null,
		);
	}

	// Why the talk wouldn't start with this state.
	function stops(d) {
		const st = stateFor(d);
		const out = R.failing(d.if, {project: S.data, state: st, owner: d.character}).map(c => describeCond(c, WORDS));
		if (d.places.length && !d.places.includes(st.place)) out.unshift(t('being at {list}', {list: WORDS.list(d.places, WORDS.place)}));
		return out;
	}

	function refreshWarn() {
		const el = document.getElementById('sim-warn');
		const d = curDlg();
		if (!el || !d) return;
		const why = stops(d);
		el.hidden = !why.length;
		el.textContent = why.length ? t('With this state the talk wouldn\'t start: it needs {list}.', {list: why.join(t(' and '))}) : '';
	}

	function who(id, mood) {
		if (id === NARRATOR) return '';
		return charName(id).toUpperCase() + (mood ? ` · ${mood}` : '');
	}

	function drawBox(d) {
		const box = h('div', {class: 'gamebox'});
		const ev = run.current;
		const r = run.r;
		if (!ev || ev.type === 'end') {
			const st = r.state;
			const lines = charStats(S.data).filter(() => d.character !== PLAYER).map(s => `${s.name} ${R.getStat(S.data, st, s.id, d.character)}`);
			box.append(h('div', {class: 'sim-end'}, t('End of the talk')),
				lines.length ? h('div', {class: 'dim'}, `${charName(d.character)}: ${lines.join(' · ')}`) : null,
				h('div', {class: 'dim tiny'}, `${t('Day')} ${st.day}, ${hh(st.hour)}`));
			return box;
		}
		if (ev.type === 'line') {
			const narr = ev.who === NARRATOR;
			box.append(
				h('div', {class: 'who', style: `--c:${charColor(ev.who)}`}, who(ev.who, ev.mood)),
				h('div', {class: 'words' + (narr ? ' narr' : '')}, r.fill(ev.text)),
				h('button', {class: 'goon', onclick: () => { pump(); draw(); }}, t('Click to go on') + ' ▸'));
			return box;
		}
		if (ev.type === 'choice') {
			const last = run.lastLine;
			box.append(
				h('div', {class: 'who', style: last ? `--c:${charColor(last.who)}` : ''}, last ? who(last.who, last.mood) : ''),
				h('div', {class: 'words' + (last && last.who === NARRATOR ? ' narr' : '')}, last ? r.fill(last.text) : ''),
				h('div', {class: 'answers'}, ev.options.map((o, i) => h('button', {onclick: () => { r.choose(o.id); pump(); draw(); }}, `${i + 1}.  ${r.fill(o.text) || t('(empty option)')}`))));
			if (ev.hidden.length) {
				box.append(h('div', {class: 'hidden-opts'}, t('Not offered now:'),
					h('ul', null, ev.hidden.map(o => h('li', null, t('“{text}”: needs {list}', {text: o.text || t('(empty option)'), list: o.failing.map(c => describeCond(c, WORDS)).join(t(' and '))}))))));
			}
			return box;
		}
		// (an item is awaited)
		const pick = h('select', null, S.data.items.map(x => h('option', {value: x.id}, x.name + (r.state.items[x.id] ? ` (${r.state.items[x.id]})` : ''))));
		if (ev.ask.item) pick.value = ev.ask.item;
		const asked = ev.ask.text || (ev.ask.item ? WORDS.item(ev.ask.item) : '');
		box.append(
			h('div', {class: 'who', style: `--c:${charColor(d.character)}`}, t('{name} WAITS FOR AN ITEM', {name: charName(d.character).toUpperCase()})),
			h('div', {class: 'words narr'}, asked ? t('Asks for: {item}', {item: asked}) : t('Asks for nothing in particular.')),
			h('div', {class: 'serve'},
				S.data.items.length ? pick : h('div', {class: 'dim tiny'}, t('The project has no items.')),
				h('div', {class: 'serve-row'},
					S.data.items.length ? h('button', {class: 'primary', onclick: () => { r.give(pick.value); pump(); draw(); }}, t('Give it')) : null,
					h('button', {onclick: () => { r.give(null); pump(); draw(); }}, t('Give nothing')))));
		return box;
	}

	function drawLog() {
		if (!run.log.length) return null;
		return h('div', {class: 'sim-log'}, run.log.map(e => {
			if (e.sys !== undefined) return h('div', {class: 'sys' + (e.minus ? ' minus' : '')}, '◆ ' + e.sys);
			if (e.you !== undefined) return h('div', {class: 'you'}, '▸ ' + e.you);
			if (e.who === NARRATOR) return h('div', {class: 'narr'}, e.text);
			return h('div', {style: `--c:${charColor(e.who)}`}, h('b', null, charName(e.who) + (e.mood ? ` (${e.mood})` : '') + ': '), e.text);
		}));
	}

	function drawTry() {
		const d = curDlg();
		if (!d || S.view !== 'dialogue') return h('div', {class: 'dim'}, t('Pick a talk to try it out.'));
		const playing = run && run.dlg === d.id;
		const why = stops(d);
		return h('div', null,
			h('div', {class: 'dim tiny', style: 'margin-bottom:6px'}, t('The state to start from:')),
			drawState(d),
			h('div', {class: 'sim-buttons'},
				h('button', {class: 'primary', onclick: () => startRun(d)}, playing ? '↻ ' + t('Start again') : '▶ ' + t('Start')),
				playing ? h('button', {onclick: () => { run = null; draw(); }}, t('Stop')) : null,
				h('button', {class: 'ghost', title: t('Back to what the project says'), onclick: () => { states.delete(d.id); draw(); }}, t('Reset'))),
			h('div', {id: 'sim-warn', class: 'sim-warn', hidden: !why.length}, why.length ? t('With this state the talk wouldn\'t start: it needs {list}.', {list: why.join(t(' and '))}) : ''),
			playing ? [drawBox(d), drawLog()] : null,
		);
	}

	// ------------------------------------------------------------ the map

	function drawMap() {
		const d = curDlg();
		if (!d || S.view !== 'dialogue') return h('div', {class: 'dim'}, t('Pick a talk to see its map.'));
		const W = 164, H = 50, GX = 56, GY = 14, PAD = 12;
		const depth = new Map([[d.start, 0]]);
		const order = d.nodes[d.start] ? [d.start] : [];
		for (let i = 0; i < order.length; i++) {
			for (const to of nodeNexts(d.nodes[order[i]])) {
				if (!depth.has(to) && d.nodes[to]) {
					depth.set(to, depth.get(order[i]) + 1);
					order.push(to);
				}
			}
		}
		const reach = new Set(order);
		const maxDepth = Math.max(0, ...depth.values());
		for (const id of Object.keys(d.nodes)) {
			if (reach.has(id)) continue;
			depth.set(id, maxDepth + 1);
			order.push(id);
		}
		const rows = new Map();
		const pos = new Map();
		for (const id of order) {
			const col = depth.get(id);
			const row = rows.get(col) || 0;
			rows.set(col, row + 1);
			pos.set(id, {x: PAD + col * (W + GX), y: PAD + row * (H + GY)});
		}
		const cols = Math.max(0, ...[...depth.values()]) + 1;
		const width = PAD * 2 + cols * (W + GX) - GX;
		const height = PAD * 2 + Math.max(1, ...rows.values()) * (H + GY) - GY;
		const NS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(NS, 'svg');
		svg.setAttribute('width', width);
		svg.setAttribute('height', height);
		const el = (tag, attrs, text) => {
			const e = document.createElementNS(NS, tag);
			for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
			if (text !== undefined) e.textContent = text;
			return e;
		};
		const defs = el('defs', {});
		const marker = el('marker', {id: 'arrow', markerWidth: 8, markerHeight: 8, refX: 7, refY: 3, orient: 'auto'});
		marker.append(el('path', {d: 'M0,0 L7,3 L0,6 z', class: 'map-arrow'}));
		defs.append(marker);
		svg.append(defs);
		const edge = (from, to, label) => {
			const a = pos.get(from), b = pos.get(to);
			if (!a || !b) return;
			const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
			const path = x2 <= x1
				? `M${a.x + W / 2},${a.y + H} C${a.x + W / 2},${a.y + H + 26} ${b.x + W / 2},${b.y + H + 26} ${b.x + W / 2},${b.y + H}`
				: `M${x1},${y1} C${x1 + 26},${y1} ${x2 - 26},${y2} ${x2},${y2}`;
			svg.append(el('path', {class: 'map-edge', d: path, 'marker-end': 'url(#arrow)'}));
			if (label) svg.append(el('text', {class: 'map-label', x: (x1 + x2) / 2 - 4, y: (y1 + y2) / 2 - 3}, label));
		};
		for (const id of order) {
			const n = d.nodes[id];
			if (n.mode === 'line') {
				if (n.next !== 'end') edge(id, n.next);
				continue;
			}
			n.options.forEach((o, i) => {
				if (o.next === 'end' || o.next === 'back') return;
				const gains = d.character !== PLAYER ? charStats(S.data).map(s => statGain(o, d.character, s.id)).filter(Boolean).map(signed).join(' ') : '';
				edge(id, o.next, [n.mode === 'choice' ? String(i + 1) : '', gains].filter(Boolean).join(' '));
			});
		}
		const MODE_WORD = {choice: t('choice'), give: t('item'), branch: t('branch'), random: t('random'), line: ''};
		for (const id of order) {
			const n = d.nodes[id];
			const p = pos.get(id);
			const g = el('g', {class: 'map-node' + (id === d.start ? ' start' : '') + (reach.has(id) ? '' : ' loose'), transform: `translate(${p.x},${p.y})`});
			g.append(el('rect', {width: W, height: H, rx: 4}));
			const first = n.lines.find(l => l.text.trim());
			const text = first ? first.text : (n.mode === 'line' ? t('(empty)') : t('({n} branches)', {n: n.options.length}));
			g.append(el('text', {x: 8, y: 16, class: 'sm'}, `${id}${first ? ' · ' + charName(first.who) : ''}`));
			g.append(el('text', {x: 8, y: 30}, text.length > 28 ? text.slice(0, 28) + '…' : text));
			const ends = n.mode === 'line' ? (n.next === 'end' ? 1 : 0) : n.options.filter(o => o.next === 'end').length;
			const tail = [MODE_WORD[n.mode] ? `${MODE_WORD[n.mode]} ${n.options.length}` : '', ends ? (n.mode === 'line' ? t('end') : `${ends} ${t('end')}`) : ''].filter(Boolean).join(' · ');
			g.append(el('text', {x: 8, y: 43, class: 'sm'}, tail));
			g.addEventListener('click', () => flashNode(id));
			svg.append(g);
		}
		return h('div', null,
			h('div', {class: 'dim tiny', style: 'margin-bottom:6px'}, t('Click a block to go to it. Dashed: nothing leads there.')),
			h('div', {class: 'map-wrap'}, svg));
	}

	// ------------------------------------------------------------ what's wrong

	function drawReview(issues) {
		if (!issues.length) return h('div', {class: 'all-good'}, t('Nothing to review in the whole project.'));
		const rank = {error: 0, warn: 1};
		issues.sort((a, b) => rank[a.level] - rank[b.level]);
		return h('div', null,
			h('div', {class: 'dim tiny', style: 'margin-bottom:6px'}, t('The whole project. Red: wouldn\'t work. Yellow: worth a look. Click to go there.')),
			issues.map(i => {
				const d = dlgById(i.dlg);
				return h('button', {
					class: 'issue ' + i.level,
					onclick: () => {
						selectDlg(d.id);
						if (i.node) setTimeout(() => flashNode(i.node), 60);
					},
				}, i.text, h('small', null, `${charName(d.character)} · ${d.title || d.id}${i.node ? ' · ' + i.node : ''}`));
			}));
	}

	function refreshBadge() {
		const review = document.querySelectorAll('#panel .tabs button')[2];
		if (!review) return;
		review.replaceChildren(t('Review'), ...[badge(reviewProject(S.data, WORDS))].filter(Boolean));
	}

	return {
		// Words typed: the map and the review can follow; a test in progress stays as it is.
		onEdit() {
			if (tab !== 'try') draw();
			else refreshBadge();
		},
		// Another talk, or its shape changed.
		onStructure() {
			if (run && (!curDlg() || run.dlg !== curDlg().id)) run = null;
			draw();
		},
		playFrom(id) {
			const d = curDlg();
			tab = 'try';
			document.getElementById('app').classList.remove('no-panel');
			renderTop();
			startRun(d, id);
		},
	};
})();
