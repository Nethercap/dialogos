'use strict';
// The project's setup page: what the game keeps track of (stats), its time, places, items and
// flags, and the limits of its text box. The talks point at all of these by id.

const LANG_CODES = ['en', 'es', 'pt', 'fr', 'de', 'it', 'ja', 'ko', 'zh', 'ru', 'pl', 'tr'];

function renderProject() {
	const p = S.data;
	const me = charById(PLAYER);
	return h('div', {class: 'sheet setup'},
		h('h2', null, t('Project setup')),
		h('section', null,
			h('div', {class: 'sheet-row'},
				h('label', null, t('Title'), inputField(p, 'title', {class: 'name', placeholder: t('My project')}, renderTop)),
				h('label', {title: t('The language the talks are written in')}, t('Written in'), inputField(p, 'lang', {list: 'dl-langs', style: 'width:70px'})),
				me ? h('label', {title: t('What the player is called in the talks')}, t('The player is called'), inputField(me, 'name', {style: 'width:140px'}, renderSide)) : null,
			),
			h('datalist', {id: 'dl-langs'}, LANG_CODES.map(c => h('option', {value: c})))),
		renderStats(p),
		renderTime(p),
		listSection({
			title: t('Places'), help: t('Where talks can happen. A talk with no place can happen anywhere.'),
			list: p.places, kind: 'place', newName: t('New place'), addLabel: t('Place'),
			columns: pl => [inputField(pl, 'notes', {class: 'notes', placeholder: t('Notes')})],
		}),
		listSection({
			title: t('Items'), help: t('What the player can have, give or show: gifts, drinks, evidence, keys… Tags group them, so a talk can react to “anything sweet”.'),
			list: p.items, kind: 'item', newName: t('New item'), addLabel: t('Item'),
			onDelete: id => { for (const c of p.characters) { c.likes = c.likes.filter(x => x !== id); c.dislikes = c.dislikes.filter(x => x !== id); } },
			columns: it => [
				h('label', {class: 'dim tiny', title: t('How many the player has when the game starts')}, t('starts with'), numField(it, 'start', {min: 0, class: 'small'})),
				wordChips(it.tags, t('tags'), allTags(p)),
				inputField(it, 'notes', {class: 'notes', placeholder: t('Notes')}),
			],
		}),
		renderFlags(p),
		h('section', null,
			h('h3', null, t('The text box')),
			h('div', {class: 'dim tiny', style: 'margin-bottom:6px'}, t('Optional checks for the game\'s text box: lines or options longer than this get a warning in Review. 0: no check.')),
			h('div', {class: 'sheet-row'},
				h('label', null, t('Characters per line'), numField(p.limits, 'lineChars', {min: 0, class: 'small'})),
				h('label', null, t('Characters per option'), numField(p.limits, 'optionChars', {min: 0, class: 'small'})),
				h('label', null, t('Options at once'), numField(p.limits, 'options', {min: 0, class: 'small'})))),
	);
}

// A list of {id, name, ...} with an editable id, a name the id follows while new, and more columns.
function listSection({title, help, list, kind, newName, addLabel, columns, onDelete, extra}) {
	const taken = () => new Set(list.map(x => x.id));
	return h('section', null,
		h('h3', null, title),
		help ? h('div', {class: 'dim tiny', style: 'margin-bottom:6px'}, help) : null,
		h('div', {class: 'rows'}, list.map((row, i) => listRow(row, i, list, kind, taken, columns, onDelete))),
		h('div', {class: 'add-row'},
			h('button', {class: 'add', onclick: () => addRow(list, kind, newName, taken)}, '+ ' + addLabel),
			extra || null));
}

function listRow(row, i, list, kind, taken, columns, onDelete) {
	const nameEl = inputField(row, 'name', {class: 'row-name', 'data-fk': `${kind}:${i}`});
	nameFollows(nameEl, kind, row, taken, () => row.name);
	const others = () => { const s = taken(); s.delete(row.id); return s; };
	return h('div', {class: 'row'},
		nameEl,
		idField(kind, row, others),
		columns ? columns(row) : null,
		h('span', {class: 'row-tools'},
			h('button', {class: 'ghost', title: t('Up'), disabled: i === 0, onclick: () => mutate(() => list.splice(i - 1, 2, list[i], list[i - 1]))}, '▲'),
			h('button', {class: 'ghost', title: t('Down'), disabled: i === list.length - 1, onclick: () => mutate(() => list.splice(i, 2, list[i + 1], list[i]))}, '▼'),
			h('button', {class: 'ghost danger', title: t('Delete'), onclick: () => deleteRow(list, row, kind, onDelete)}, '×')));
}

function addRow(list, kind, name, taken, extra) {
	const row = Object.assign({id: idFor(name, taken(), kind), name}, extra || {});
	S.autoIds.add(row);
	mutate(() => {
		list.push(row);
		normalizeProject(S.data);
	}, `${kind}:${list.length - 1}`);
	setTimeout(() => {
		const el = document.querySelector(`[data-fk="${kind}:${list.indexOf(row)}"]`);
		if (el) el.select();
	});
}

function deleteRow(list, row, kind, onDelete) {
	const refs = countRefs(S.data, kind, row.id);
	if (refs && !confirm(t('“{name}” is used {n} times. Delete it anyway? Those places will show up in Review.', {name: row.name || row.id, n: refs}))) return;
	mutate(() => {
		list.splice(list.indexOf(row), 1);
		if (onDelete) onDelete(row.id);
	});
	Panels.onStructure();
}

// ---------------------------------------------------------------- stats

function renderStats(p) {
	const missing = statPresets().filter(s => !p.stats.some(x => x.id === s.id));
	const taken = () => new Set(p.stats.map(x => x.id));
	return h('section', null,
		h('h3', null, t('Stats')),
		h('div', {class: 'dim tiny', style: 'margin-bottom:6px'},
			t('The numbers the talks move. Per character: each character has their own (how they see the player: trust, romance…), and the same stats work between two characters. Global: one for the whole game (money, reputation…).')),
		p.stats.length ? h('div', {class: 'row row-head stat-row'}, h('span'), h('span', null, t('Name')), h('span', null, 'id'), h('span', null, t('Kind')),
			h('span', null, t('Min')), h('span', null, t('Max')), h('span', null, t('Starts at')), h('span')) : null,
		p.stats.map((s, i) => {
			const nameEl = inputField(s, 'name', {class: 'row-name', 'data-fk': `stat:${i}`}, renderSide);
			nameFollows(nameEl, 'stat', s, taken, () => s.name);
			const others = () => { const x = taken(); x.delete(s.id); return x; };
			return h('div', {class: 'row stat-row'},
				h('input', {type: 'color', value: s.color, onchange: e => mutate(() => { s.color = e.target.value; })}),
				nameEl,
				idField('stat', s, others),
				selectField(s, 'scope', [['character', t('Per character')], ['global', t('Global')]], () => {
					if (s.scope === 'global') {
						for (const c of p.characters) {
							delete c.stats[s.id];
							for (const r of c.relations) delete r.values[s.id];
						}
					}
				}),
				numField(s, 'min', {placeholder: '—', class: 'small'}),
				numField(s, 'max', {placeholder: '—', class: 'small'}),
				numField(s, 'start', {class: 'small'}),
				h('span', {class: 'row-tools'},
					h('button', {class: 'ghost', title: t('Up'), disabled: i === 0, onclick: () => mutate(() => p.stats.splice(i - 1, 2, p.stats[i], p.stats[i - 1]))}, '▲'),
					h('button', {class: 'ghost', title: t('Down'), disabled: i === p.stats.length - 1, onclick: () => mutate(() => p.stats.splice(i, 2, p.stats[i + 1], p.stats[i]))}, '▼'),
					h('button', {class: 'ghost danger', title: t('Delete'), onclick: () => deleteRow(p.stats, s, 'stat', id => {
						for (const c of p.characters) {
							delete c.stats[id];
							for (const r of c.relations) delete r.values[id];
						}
					})}, '×')));
		}),
		h('div', {class: 'add-row'},
			missing.map(s => h('button', {class: 'add', title: s.scope === 'global' ? t('Global') : t('Per character'), onclick: () => mutate(() => p.stats.push(s))}, '+ ' + s.name)),
			h('button', {class: 'add', onclick: () => addRow(p.stats, 'stat', t('New stat'), taken, {scope: 'character', start: 0, color: PALETTE[p.stats.length % PALETTE.length]})}, '+ ' + t('Another stat'))));
}

// ---------------------------------------------------------------- time

function renderTime(p) {
	const time = p.time;
	const phaseIds = () => new Set(time.phases.map(x => x.id));
	return h('section', null,
		h('h3', null, t('Time')),
		h('div', {class: 'dim tiny', style: 'margin-bottom:6px'},
			t('The game counts days and hours. A part of the day lasts from its hour to the next one\'s (the last one goes past midnight). Days of the week are optional: day 1 is the first on the list.')),
		h('div', {class: 'sheet-row'},
			h('b', {class: 'dim'}, t('The game starts on')),
			h('label', null, t('day'), numField(time.start, 'day', {min: 1, class: 'small'})),
			h('label', null, t('at'), numField(time.start, 'hour', {min: 0, max: 23, class: 'small', placeholder: '—'}), ':00'),
			p.places.length ? h('label', null, t('in'), listSelect(time.start, 'place', p.places, '—')) : null),
		h('div', {class: 'time-cols'},
			h('div', null,
				h('h4', null, t('Parts of the day')),
				time.phases.map((ph, i) => {
					const nameEl = inputField(ph, 'name', {class: 'row-name', 'data-fk': `phase:${i}`});
					nameFollows(nameEl, 'phase', ph, phaseIds, () => ph.name);
					const others = () => { const x = phaseIds(); x.delete(ph.id); return x; };
					return h('div', {class: 'row'},
						nameEl, idField('phase', ph, others),
						h('label', {class: 'dim tiny'}, t('from'), numField(ph, 'start', {min: 0, max: 23, class: 'small'}), ':00'),
						h('button', {class: 'ghost danger', title: t('Delete'), onclick: () => deleteRow(time.phases, ph, 'phase')}, '×'));
				}),
				h('div', {class: 'add-row'},
					h('button', {class: 'add', onclick: () => addRow(time.phases, 'phase', t('New part of the day'), phaseIds, {start: 12})}, '+ ' + t('Part of the day')),
					!time.phases.length ? h('button', {class: 'add', onclick: () => mutate(() => { time.phases = phasePreset(); })}, t('Morning, afternoon, evening, night')) : null)),
			h('div', null,
				h('h4', null, t('Days of the week')),
				time.weekdays.map((w, i) => {
					const ids = () => new Set(time.weekdays.map(x => x.id));
					const nameEl = inputField(w, 'name', {class: 'row-name', 'data-fk': `weekday:${i}`});
					nameFollows(nameEl, 'weekday', w, ids, () => w.name);
					const others = () => { const x = ids(); x.delete(w.id); return x; };
					return h('div', {class: 'row'}, nameEl, idField('weekday', w, others),
						h('span', {class: 'row-tools'},
							h('button', {class: 'ghost', title: t('Up'), disabled: i === 0, onclick: () => mutate(() => time.weekdays.splice(i - 1, 2, time.weekdays[i], time.weekdays[i - 1]))}, '▲'),
							h('button', {class: 'ghost danger', title: t('Delete'), onclick: () => deleteRow(time.weekdays, w, 'weekday')}, '×')));
				}),
				h('div', {class: 'add-row'},
					h('button', {class: 'add', onclick: () => addRow(time.weekdays, 'weekday', t('New day'), () => new Set(time.weekdays.map(x => x.id)))}, '+ ' + t('Day')),
					!time.weekdays.length ? h('button', {class: 'add', onclick: () => mutate(() => { time.weekdays = weekdayPreset(); })}, t('Monday to Sunday')) : null))));
}

// ---------------------------------------------------------------- flags

function renderFlags(p) {
	const declared = new Set(p.flags.map(f => f.id));
	const fromTalks = allFlags(p).filter(f => !declared.has(f));
	const taken = () => new Set(p.flags.map(f => f.id));
	return h('section', null,
		h('h3', null, t('Flags')),
		h('div', {class: 'dim tiny', style: 'margin-bottom:6px'},
			t('On/off marks. Talks turn them on and off with “Also…”; list here the ones the game sets by itself, or that start on, so Review knows they exist.')),
		p.flags.map((f, i) => {
			const others = () => { const s = taken(); s.delete(f.id); return s; };
			return h('div', {class: 'row'},
				flagIdField(f, others),
				h('label', {class: 'dim tiny'}, h('input', {type: 'checkbox', checked: f.start, onchange: e => mutate(() => { f.start = e.target.checked; })}), t('starts on')),
				inputField(f, 'notes', {class: 'notes', placeholder: t('Who sets it, and when')}),
				h('button', {class: 'ghost danger', title: t('Delete'), onclick: () => mutate(() => p.flags.splice(i, 1))}, '×'));
		}),
		h('div', {class: 'add-row'},
			h('button', {class: 'add', onclick: () => mutate(() => p.flags.push({id: nextFreeId('flag_', taken()), start: false, notes: ''}), `flag:${p.flags.length}`)}, '+ ' + t('Flag')),
			fromTalks.length ? h('span', {class: 'dim tiny'}, t('Used in talks:'), ' ', fromTalks.map(f => h('button', {class: 'chip-btn', title: t('List it here'), onclick: () => mutate(() => p.flags.push({id: f, start: false, notes: ''}))}, '+ ' + f))) : null));
}

// A flag is its id: renaming it renames it in every talk.
function flagIdField(f, others) {
	const el = h('input', {class: 'row-name mono', value: f.id, 'data-fk': `flag:${S.data.flags.indexOf(f)}`, spellcheck: false});
	el.onchange = () => {
		const want = slug(el.value);
		if (!want || want === f.id) {
			el.value = f.id;
			return;
		}
		if (others().has(want)) {
			el.value = f.id;
			return toast(t('The id “{id}” is taken.', {id: want}));
		}
		const from = f.id;
		mutate(() => {
			renameRefs(S.data, 'flag', from, want);
			f.id = want;
		});
	};
	return el;
}
