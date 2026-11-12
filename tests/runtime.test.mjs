// Tests for web/runtime.js, with nothing but Node.  Run: node --test tests
import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';

const require = createRequire(import.meta.url);
const RUNTIME = fileURLToPath(new URL('../web/runtime.js', import.meta.url));
const D = require(RUNTIME);
const cafe = JSON.parse(readFileSync(new URL('../examples/cafe.json', import.meta.url), 'utf8'));

// ---------------------------------------------------------------- helpers

function project(dialogues = []) {
	return {
		format: 'dialogos', version: 1,
		stats: [
			{id: 'trust', scope: 'character', min: 0, max: 10, start: 1},
			{id: 'fear', scope: 'character'},
			{id: 'money', scope: 'global', min: 0, start: 20},
			{id: 'karma', scope: 'global'},
		],
		time: {
			start: {day: 1, hour: 8, place: 'cafe'},
			phases: [{id: 'morning', start: 6}, {id: 'afternoon', start: 12}, {id: 'evening', start: 18}, {id: 'night', start: 22}],
			weekdays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map(id => ({id})),
		},
		places: [{id: 'cafe'}, {id: 'beach'}],
		items: [
			{id: 'rose', name: 'Rose', tags: ['flower', 'gift']},
			{id: 'espresso', name: 'Espresso', tags: ['coffee', 'drink'], start: 2},
			{id: 'lemonade', name: 'Lemonade', tags: ['drink']},
		],
		flags: [{id: 'rain', start: true}, {id: 'storm'}],
		characters: [
			{id: 'player', name: 'Sam'},
			{id: 'mia', name: 'Mia', stats: {trust: 3}, likes: ['espresso'], dislikes: ['lemonade'],
				relations: [{to: 'leo', label: 'old friend', values: {trust: 4}}]},
			{id: 'leo', name: 'Leo'},
		],
		dialogues,
	};
}

// A project with one talk of Mia's, 't', that starts at n1.
const talk = (nodes, extra = {}) => project([{id: 't', character: 'mia', title: 'T', status: 'ready', start: 'n1', nodes, ...extra}]);

// Plays a run to its end. answers: option ids for choices, item ids (or null) for gifts, in order.
function play(run, answers = []) {
	const events = [];
	const queue = [...answers];
	for (let i = 0; i < 10000; i++) {
		const ev = run.next();
		events.push(ev);
		if (ev.type === 'end') return events;
		if (ev.type === 'choice' || ev.type === 'give') {
			assert.ok(queue.length, 'nothing left to answer ' + JSON.stringify(ev));
			if (ev.type === 'choice') run.choose(queue.shift());
			else run.give(queue.shift());
		}
	}
	assert.fail('the talk never ended');
}

// Runs CommonJS source in a worker (workerData.runtime: the runtime's path) and resolves with its
// first message; fails if it takes longer than ms.
function inWorker(ms, source) {
	return new Promise((resolve, reject) => {
		const w = new Worker(source, {eval: true, workerData: {runtime: RUNTIME}});
		const timer = setTimeout(() => {
			w.terminate();
			reject(new Error(`still running after ${ms} ms`));
		}, ms);
		w.once('message', m => {
			clearTimeout(timer);
			w.terminate();
			resolve(m);
		});
		w.once('error', e => {
			clearTimeout(timer);
			reject(e);
		});
	});
}

const said = events => events.filter(e => e.type === 'line').map(e => e.text);
const kinds = events => events.map(e => e.type);
const cx = (p, state, more = {}) => ({project: p, state, owner: 'mia', ...more});

// ---------------------------------------------------------------- the state

describe('newState', () => {
	const p = project();

	test('character stats start from the sheet, else from the stat', () => {
		const st = D.newState(p);
		assert.deepEqual(st.stats, {trust: {mia: 3}, fear: {}});
		assert.equal(D.getStat(p, st, 'trust', 'mia'), 3);
		assert.equal(D.getStat(p, st, 'trust', 'leo'), 1);
		assert.equal(D.getStat(p, st, 'fear', 'mia'), 0);
	});

	test('global stats start from the stat', () => {
		const st = D.newState(p);
		assert.deepEqual(st.globals, {money: 20, karma: 0});
		assert.equal(D.getStat(p, st, 'money'), 20);
	});

	test('relations start from the sheet, else from the stat', () => {
		const st = D.newState(p);
		assert.deepEqual(st.relations, {trust: {'mia>leo': 4}});
		assert.equal(D.getRelation(p, st, 'trust', 'mia', 'leo'), 4);
		assert.equal(D.getRelation(p, st, 'trust', 'leo', 'mia'), 1);
	});

	test('items, flags, time and place', () => {
		const st = D.newState(p);
		assert.deepEqual(st.items, {espresso: 2});
		assert.deepEqual(st.flags, {rain: true});
		assert.deepEqual(st.seen, {});
		assert.equal(st.day, 1);
		assert.equal(st.hour, 8);
		assert.equal(st.place, 'cafe');
	});

	test('a state missing a value reads where the project says it starts (an older save)', () => {
		const st = D.newState(p);
		st.stats = {};
		st.globals = {};
		st.relations = {};
		assert.equal(D.getStat(p, st, 'trust', 'mia'), 3);
		assert.equal(D.getStat(p, st, 'trust', 'leo'), 1);
		assert.equal(D.getStat(p, st, 'money'), 20);
		assert.equal(D.getRelation(p, st, 'trust', 'mia', 'leo'), 4);
		assert.equal(D.getRelation(p, st, 'trust', 'leo', 'mia'), 1);
	});

	test('defaults when the file says nothing', () => {
		assert.deepEqual(D.newState({}), {stats: {}, globals: {}, relations: {}, flags: {}, items: {}, seen: {}, day: 1, hour: 8, place: ''});
		const st = D.newState({time: {phases: [{id: 'night', start: 22}, {id: 'dawn', start: 5}]}});
		assert.equal(st.hour, 5);
	});
});

// ---------------------------------------------------------------- time

describe('time', () => {
	const p = project();

	test('phaseAt: the last phase started by then', () => {
		assert.equal(D.phaseAt(p, 6), 'morning');
		assert.equal(D.phaseAt(p, 11), 'morning');
		assert.equal(D.phaseAt(p, 12), 'afternoon');
		assert.equal(D.phaseAt(p, 21), 'evening');
		assert.equal(D.phaseAt(p, 23), 'night');
	});

	test('phaseAt: before the first phase it is still the last one', () => {
		assert.equal(D.phaseAt(p, 0), 'night');
		assert.equal(D.phaseAt(p, 5), 'night');
	});

	test('phaseAt: the file order of phases does not matter; no phases, no phase', () => {
		const shuffled = {time: {phases: [{id: 'night', start: 22}, {id: 'day', start: 7}]}};
		assert.equal(D.phaseAt(shuffled, 10), 'day');
		assert.equal(D.phaseAt(shuffled, 3), 'night');
		assert.equal(D.phaseAt({}, 10), '');
	});

	test('weekdayOf: day 1 is the first weekday, and round', () => {
		assert.equal(D.weekdayOf(p, 1), 'mon');
		assert.equal(D.weekdayOf(p, 7), 'sun');
		assert.equal(D.weekdayOf(p, 8), 'mon');
		assert.equal(D.weekdayOf(p, 30), 'tue');
		assert.equal(D.weekdayOf(p, 0), 'sun');
		assert.equal(D.weekdayOf(p, -6), 'mon');
		assert.equal(D.weekdayOf({}, 3), '');
	});

	test('inHours: from up to (not including) to', () => {
		assert.equal(D.inHours(9, 9, 17), true);
		assert.equal(D.inHours(16, 9, 17), true);
		assert.equal(D.inHours(17, 9, 17), false);
		assert.equal(D.inHours(8, 9, 17), false);
	});

	test('inHours: past midnight when from > to', () => {
		assert.equal(D.inHours(20, 20, 2), true);
		assert.equal(D.inHours(23, 20, 2), true);
		assert.equal(D.inHours(0, 20, 2), true);
		assert.equal(D.inHours(1, 20, 2), true);
		assert.equal(D.inHours(2, 20, 2), false);
		assert.equal(D.inHours(19, 20, 2), false);
	});

	test('inHours: equal or missing hours mean the whole day', () => {
		assert.equal(D.inHours(3, 5, 5), true);
		assert.equal(D.inHours(3, undefined, 5), true);
	});
});

// ---------------------------------------------------------------- conditions

describe('conditions', () => {
	const p = project();
	const holds = (cond, state, more) => D.holds(cond, cx(p, state || D.newState(p), more));

	test('compare: every op, and == when there is none', () => {
		const cases = [
			[3, '>=', 3, true], [2, '>=', 3, false], [3, '<=', 3, true], [4, '<=', 3, false],
			[3, '==', 3, true], [3, '==', 4, false], [3, '!=', 4, true], [3, '!=', 3, false],
			[4, '>', 3, true], [3, '>', 3, false], [2, '<', 3, true], [3, '<', 3, false],
			[3, undefined, 3, true], [3, undefined, 4, false],
		];
		for (const [a, op, b, want] of cases) assert.equal(D.compare(a, op, b), want, `${a} ${op} ${b}`);
	});

	test('stat: every op, against the talk\'s character when no who', () => {
		// Mia's trust is 3
		const want = {'>=': true, '<=': true, '==': true, '!=': false, '>': false, '<': false};
		for (const [op, w] of Object.entries(want)) assert.equal(holds({type: 'stat', stat: 'trust', op, value: 3}), w, op);
		assert.equal(holds({type: 'stat', stat: 'trust', op: '>', value: 2}), true);
		assert.equal(holds({type: 'stat', stat: 'trust', op: '<', value: 4}), true);
		assert.equal(holds({type: 'stat', stat: 'trust', op: '!=', value: 1}), true);
	});

	test('stat: an explicit who, and global stats', () => {
		assert.equal(holds({type: 'stat', stat: 'trust', who: 'leo', op: '==', value: 1}), true);
		assert.equal(holds({type: 'stat', stat: 'money', op: '>=', value: 20}), true);
		assert.equal(holds({type: 'stat', stat: 'money', who: 'leo', op: '==', value: 20}), true);
	});

	test('relation: how from sees to', () => {
		assert.equal(holds({type: 'relation', stat: 'trust', from: 'mia', to: 'leo', op: '>=', value: 4}), true);
		assert.equal(holds({type: 'relation', stat: 'trust', from: 'mia', to: 'leo', op: '>', value: 4}), false);
		assert.equal(holds({type: 'relation', stat: 'trust', from: 'leo', to: 'mia', op: '==', value: 1}), true);
	});

	test('flag: on, off, and a missing value means on', () => {
		assert.equal(holds({type: 'flag', name: 'rain', value: true}), true);
		assert.equal(holds({type: 'flag', name: 'rain', value: false}), false);
		assert.equal(holds({type: 'flag', name: 'rain'}), true);
		assert.equal(holds({type: 'flag', name: 'storm', value: false}), true);
		assert.equal(holds({type: 'flag', name: 'storm', value: true}), false);
	});

	test('item: at least one by default, or compared', () => {
		assert.equal(holds({type: 'item', item: 'espresso'}), true);
		assert.equal(holds({type: 'item', item: 'rose'}), false);
		assert.equal(holds({type: 'item', item: 'espresso', op: '==', value: 2}), true);
		assert.equal(holds({type: 'item', item: 'espresso', op: '>', value: 2}), false);
		assert.equal(holds({type: 'item', item: 'rose', op: '==', value: 0}), true);
		assert.equal(holds({type: 'item', item: 'rose', op: '<', value: 1}), true);
	});

	test('day', () => {
		const st = D.newState(p);
		st.day = 3;
		assert.equal(holds({type: 'day', op: '>=', value: 2}, st), true);
		assert.equal(holds({type: 'day', op: '<', value: 3}, st), false);
		assert.equal(holds({type: 'day', op: '==', value: 3}, st), true);
		assert.equal(holds({type: 'day', op: '!=', value: 3}, st), false);
	});

	test('weekday', () => {
		const st = D.newState(p);
		st.day = 6;
		assert.equal(holds({type: 'weekday', is: ['sat', 'sun']}, st), true);
		st.day = 8;
		assert.equal(holds({type: 'weekday', is: ['sat', 'sun']}, st), false);
		assert.equal(holds({type: 'weekday', is: ['mon']}, st), true);
	});

	test('phase, including past midnight', () => {
		const st = D.newState(p);
		for (const [hour, want] of [[8, 'morning'], [19, 'evening'], [23, 'night'], [2, 'night']]) {
			st.hour = hour;
			assert.equal(holds({type: 'phase', is: [want]}, st), true, `${hour}h is ${want}`);
			assert.equal(holds({type: 'phase', is: ['afternoon']}, st), false, `${hour}h is not afternoon`);
		}
	});

	test('hour, across midnight', () => {
		const st = D.newState(p);
		for (const [hour, want] of [[23, true], [1, true], [2, false], [19, false], [20, true]]) {
			st.hour = hour;
			assert.equal(holds({type: 'hour', from: 20, to: 2}, st), want, `${hour}h`);
		}
	});

	test('place', () => {
		assert.equal(holds({type: 'place', is: ['cafe', 'beach']}), true);
		assert.equal(holds({type: 'place', is: ['beach']}), false);
	});

	test('seen: true, false, and a missing value means seen', () => {
		const st = D.newState(p);
		assert.equal(holds({type: 'seen', dialogue: 'x', value: false}, st), true);
		assert.equal(holds({type: 'seen', dialogue: 'x', value: true}, st), false);
		st.seen.x = 2;
		assert.equal(holds({type: 'seen', dialogue: 'x', value: true}, st), true);
		assert.equal(holds({type: 'seen', dialogue: 'x', value: false}, st), false);
		assert.equal(holds({type: 'seen', dialogue: 'x'}, st), true);
	});

	test('the given… family, before, without and with a gift', () => {
		// given: undefined = no gift yet, null = gave nothing. Mia likes espresso, dislikes lemonade; rose was asked for.
		const gifts = [undefined, null, 'rose', 'espresso', 'lemonade'];
		const table = [
			[{type: 'given', is: ['rose']}, [false, false, true, false, false]],
			[{type: 'given_not', is: ['rose']}, [false, false, false, true, true]],
			[{type: 'given_tag', tags: ['drink']}, [false, false, false, true, true]],
			[{type: 'given_tag', tags: ['gift', 'coffee']}, [false, false, true, true, false]],
			[{type: 'given_liked'}, [false, false, false, true, false]],
			[{type: 'given_disliked'}, [false, false, false, false, true]],
			[{type: 'given_asked'}, [false, false, true, false, false]],
			[{type: 'given_none'}, [false, true, false, false, false]],
		];
		const st = D.newState(p);
		for (const [cond, want] of table) {
			gifts.forEach((given, i) => {
				assert.equal(holds(cond, st, {given, asked: 'rose'}), want[i], `${JSON.stringify(cond)} with ${given}`);
			});
		}
		assert.equal(holds({type: 'given_asked'}, st, {given: 'rose', asked: ''}), false);
	});

	test('a type nobody knows doesn\'t hold; a game can add its own', () => {
		assert.equal(holds({type: 'weather', is: 'sunny'}), false);
		const conditions = {weather: (c, x) => c.is === 'sunny' && x.owner === 'mia'};
		assert.equal(holds({type: 'weather', is: 'sunny'}, undefined, {conditions}), true);
		assert.equal(holds({type: 'weather', is: 'rainy'}, undefined, {conditions}), false);
		// its own handler wins over the built-in one
		assert.equal(holds({type: 'flag', name: 'rain'}, undefined, {conditions: {flag: () => false}}), false);
	});

	test('allHold and failing', () => {
		const x = cx(p, D.newState(p));
		const yes = {type: 'flag', name: 'rain'};
		const no = {type: 'flag', name: 'storm'};
		assert.equal(D.allHold([], x), true);
		assert.equal(D.allHold(undefined, x), true);
		assert.equal(D.allHold([yes, no], x), false);
		assert.deepEqual(D.failing([yes, no], x), [no]);
	});
});

// ---------------------------------------------------------------- effects

describe('effects', () => {
	const p = project();
	const run = (effect, st = D.newState(p)) => {
		D.apply(effect, p, st, 'mia');
		return st;
	};

	test('stat: up and down, for the talk\'s character or whoever is named', () => {
		const st = run({type: 'stat', stat: 'trust', delta: 2});
		assert.equal(D.getStat(p, st, 'trust', 'mia'), 5);
		run({type: 'stat', stat: 'trust', delta: -1}, st);
		assert.equal(D.getStat(p, st, 'trust', 'mia'), 4);
		run({type: 'stat', stat: 'trust', who: 'leo', delta: 3}, st);
		assert.equal(D.getStat(p, st, 'trust', 'leo'), 4);
		assert.equal(D.getStat(p, st, 'trust', 'mia'), 4);
	});

	test('stat: never past min or max; no bounds, no limit', () => {
		const st = run({type: 'stat', stat: 'trust', delta: 50});
		assert.equal(D.getStat(p, st, 'trust', 'mia'), 10);
		run({type: 'stat', stat: 'trust', delta: -50}, st);
		assert.equal(D.getStat(p, st, 'trust', 'mia'), 0);
		run({type: 'stat', stat: 'fear', delta: -5}, st);
		assert.equal(D.getStat(p, st, 'fear', 'mia'), -5);
	});

	test('stat: global stats', () => {
		const st = run({type: 'stat', stat: 'money', delta: 5});
		assert.equal(st.globals.money, 25);
		run({type: 'stat', stat: 'money', delta: -100}, st);
		assert.equal(st.globals.money, 0);
		run({type: 'stat', stat: 'karma', delta: -3}, st);
		assert.equal(st.globals.karma, -3);
	});

	test('relation: changed and clamped', () => {
		const st = run({type: 'relation', stat: 'trust', from: 'mia', to: 'leo', delta: 2});
		assert.equal(D.getRelation(p, st, 'trust', 'mia', 'leo'), 6);
		assert.equal(D.getRelation(p, st, 'trust', 'leo', 'mia'), 1);
		run({type: 'relation', stat: 'trust', from: 'leo', to: 'mia', delta: -9}, st);
		assert.equal(D.getRelation(p, st, 'trust', 'leo', 'mia'), 0);
	});

	test('flag: on, off, and a missing value means on', () => {
		const st = run({type: 'flag', name: 'storm', value: true});
		assert.equal(st.flags.storm, true);
		run({type: 'flag', name: 'storm', value: false}, st);
		assert.equal(st.flags.storm, false);
		run({type: 'flag', name: 'storm'}, st);
		assert.equal(st.flags.storm, true);
	});

	test('item: given and taken, never below 0', () => {
		const st = run({type: 'item', item: 'rose', delta: 2});
		assert.equal(st.items.rose, 2);
		run({type: 'item', item: 'rose', delta: -1}, st);
		assert.equal(st.items.rose, 1);
		run({type: 'item', item: 'rose', delta: -5}, st);
		assert.equal(st.items.rose, 0);
		run({type: 'item', item: 'lemonade', delta: -1}, st);
		assert.equal(st.items.lemonade, 0);
	});

	const at = (day, hour) => Object.assign(D.newState(p), {day, hour});
	const when = st => [st.day, st.hour];

	test('time: hours, rolling over into the next days', () => {
		assert.deepEqual(when(run({type: 'time', unit: 'hours', amount: 5}, at(1, 8))), [1, 13]);
		assert.deepEqual(when(run({type: 'time', unit: 'hours', amount: 10}, at(1, 20))), [2, 6]);
		assert.deepEqual(when(run({type: 'time', unit: 'hours', amount: 48}, at(1, 8))), [3, 8]);
		assert.deepEqual(when(run({type: 'time', amount: 2}, at(1, 8))), [1, 10]);
	});

	test('time: phases go to the start of the next part of the day', () => {
		assert.deepEqual(when(run({type: 'time', unit: 'phases', amount: 1}, at(1, 8))), [1, 12]);
		assert.deepEqual(when(run({type: 'time', unit: 'phases', amount: 1}, at(1, 19))), [1, 22]);
	});

	test('time: phases across midnight start a new day, but not from past-midnight night', () => {
		assert.deepEqual(when(run({type: 'time', unit: 'phases', amount: 1}, at(1, 23))), [2, 6]);
		assert.deepEqual(when(run({type: 'time', unit: 'phases', amount: 1}, at(2, 2))), [2, 6]);
		assert.deepEqual(when(run({type: 'time', unit: 'phases', amount: 2}, at(1, 19))), [2, 6]);
		assert.deepEqual(when(run({type: 'time', unit: 'phases', amount: 4}, at(1, 8))), [2, 6]);
	});

	test('time: days keep the hour', () => {
		assert.deepEqual(when(run({type: 'time', unit: 'days', amount: 3}, at(1, 15))), [4, 15]);
	});

	test('time only goes forward', () => {
		assert.deepEqual(when(run({type: 'time', unit: 'hours', amount: -5}, at(2, 8))), [2, 8]);
		assert.deepEqual(when(run({type: 'time', unit: 'days', amount: -1}, at(2, 8))), [2, 8]);
	});

	test('place', () => {
		assert.equal(run({type: 'place', place: 'beach'}).place, 'beach');
	});

	test('event and unknown types change nothing', () => {
		const st = D.newState(p);
		const before = structuredClone(st);
		run({type: 'event', name: 'play_music', text: 'Something slow.'}, st);
		run({type: 'confetti'}, st);
		assert.deepEqual(st, before);
	});
});

// ---------------------------------------------------------------- running a talk

describe('running a talk', () => {
	test('lines, then effects, then the mode', () => {
		const p = talk({n1: {
			lines: [{who: 'mia', text: 'Hi.', mood: 'happy'}, {who: 'mia', text: '   '}, {who: 'narrator', text: 'She waves.'}],
			effects: [{type: 'stat', stat: 'trust', delta: 1}],
			mode: 'choice',
			options: [{id: 'o1', text: 'Bye.', next: 'end'}],
		}});
		const st = D.newState(p);
		const run = D.start(p, 't', st);
		assert.deepEqual(run.next(), {type: 'line', node: 'n1', who: 'mia', text: 'Hi.', mood: 'happy'});
		assert.equal(D.getStat(p, st, 'trust', 'mia'), 3, 'no effect before the lines are said');
		assert.deepEqual(run.next(), {type: 'line', node: 'n1', who: 'narrator', text: 'She waves.'});
		assert.equal(D.getStat(p, st, 'trust', 'mia'), 3);
		assert.deepEqual(run.next(), {type: 'effect', node: 'n1', effect: {type: 'stat', stat: 'trust', delta: 1}});
		assert.equal(D.getStat(p, st, 'trust', 'mia'), 4);
		const choice = run.next();
		assert.deepEqual(choice, {type: 'choice', node: 'n1', options: [{id: 'o1', text: 'Bye.'}], hidden: []});
		assert.deepEqual(run.next(), choice, 'the same event again while it waits');
		run.choose('o1');
		assert.deepEqual(run.next(), {type: 'chosen', node: 'n1', option: 'o1', text: 'Bye.'});
		assert.deepEqual(run.next(), {type: 'end', dialogue: 't'});
		assert.deepEqual(run.next(), {type: 'end', dialogue: 't'});
		assert.equal(st.seen.t, 1);
	});

	test('a choice hides the options whose conditions fail, and says which fail', () => {
		const storm = {type: 'flag', name: 'storm', value: true};
		const rain = {type: 'flag', name: 'rain', value: true};
		const trusted = {type: 'stat', stat: 'trust', op: '>=', value: 9};
		const p = talk({n1: {mode: 'choice', options: [
			{id: 'o1', text: 'Plain', next: 'end'},
			{id: 'o2', text: 'Stormy', if: [storm], next: 'end'},
			{id: 'o3', text: 'Rain and trust', if: [rain, trusted], next: 'end'},
			{id: 'o4', text: 'Rainy', if: [rain], next: 'end'},
		]}});
		const run = D.start(p, 't');
		const ev = run.next();
		assert.deepEqual(ev.options, [{id: 'o1', text: 'Plain'}, {id: 'o4', text: 'Rainy'}]);
		assert.deepEqual(ev.hidden, [
			{id: 'o2', text: 'Stormy', failing: [storm]},
			{id: 'o3', text: 'Rain and trust', failing: [trusted]},
		]);
		assert.throws(() => run.choose('o2'), /not available/);
		assert.throws(() => run.choose('nope'), /not available/);
		assert.throws(() => run.give('rose'), /Nothing is awaited/);
	});

	test('an option: chosen, its effects, its reply, then its next', () => {
		const p = talk({
			n1: {mode: 'choice', options: [
				{id: 'o1', text: 'Take this.', effects: [{type: 'item', item: 'rose', delta: 1}], reply: [{who: 'mia', text: 'Thanks.'}], next: 'n2'},
				{id: 'o2', text: 'No.', next: 'end'},
			]},
			n2: {lines: [{who: 'mia', text: 'After.'}], mode: 'line', next: 'end'},
		});
		const st = D.newState(p);
		const run = D.start(p, 't', st);
		run.next();
		run.choose('o1');
		assert.equal(st.items.rose, 1, 'applied when picked');
		const rest = play(run);
		assert.deepEqual(kinds(rest), ['chosen', 'effect', 'line', 'line', 'end']);
		assert.deepEqual(said(rest), ['Thanks.', 'After.']);
	});

	test('back offers the same options again, without the ones already picked', () => {
		const p = talk({n1: {lines: [{who: 'mia', text: 'Ask away.'}], mode: 'choice', options: [
			{id: 'o1', text: 'One', reply: [{who: 'mia', text: 'First.'}], next: 'back'},
			{id: 'o2', text: 'Two', reply: [{who: 'mia', text: 'Second.'}], next: 'back'},
			{id: 'o3', text: 'Done', next: 'end'},
		]}});
		const run = D.start(p, 't');
		const offered = [];
		const events = [];
		for (let ev = run.next(); ev.type !== 'end'; ev = run.next()) {
			events.push(ev);
			if (ev.type === 'choice') {
				offered.push(ev.options.map(o => o.id));
				assert.deepEqual(ev.hidden, []);
				run.choose(ev.options[0].id);
			}
		}
		assert.deepEqual(offered, [['o1', 'o2', 'o3'], ['o2', 'o3'], ['o3']]);
		assert.deepEqual(said(events), ['Ask away.', 'First.', 'Second.'], 'the node\'s lines are not said again');
	});

	test('back with no option left: stuck, and the talk ends', () => {
		const p = talk({n1: {mode: 'choice', options: [
			{id: 'o1', text: 'One', next: 'back'},
			{id: 'o2', text: 'Two', next: 'back'},
		]}});
		const st = D.newState(p);
		const events = play(D.start(p, 't', st), ['o1', 'o2']);
		assert.deepEqual(events.at(-2), {type: 'stuck', node: 'n1', reason: 'no-options'});
		assert.equal(events.at(-1).type, 'end');
		assert.equal(st.seen.t, 1);
	});

	test('a choice with nothing to offer is stuck', () => {
		const p = talk({n1: {lines: [{who: 'mia', text: 'Well?'}], mode: 'choice', options: [
			{id: 'o1', text: 'Stormy', if: [{type: 'flag', name: 'storm', value: true}], next: 'end'},
		]}});
		const events = play(D.start(p, 't'));
		assert.deepEqual(kinds(events), ['line', 'stuck', 'end']);
		assert.equal(events[1].reason, 'no-options');
	});

	test('branch takes the first option that holds', () => {
		const p = talk({n1: {mode: 'branch', options: [
			{id: 'b1', if: [{type: 'stat', stat: 'trust', op: '>=', value: 5}], reply: [{who: 'mia', text: 'high'}], next: 'end'},
			{id: 'b2', if: [{type: 'stat', stat: 'trust', op: '>=', value: 3}], reply: [{who: 'mia', text: 'mid'}], next: 'end'},
			{id: 'b3', reply: [{who: 'mia', text: 'low'}], next: 'end'},
		]}});
		const withTrust = v => {
			const st = D.newState(p);
			D.setStat(p, st, 'trust', 'mia', v);
			return said(play(D.start(p, 't', st)));
		};
		assert.deepEqual(withTrust(3), ['mid']);
		assert.deepEqual(withTrust(9), ['high']);
		assert.deepEqual(withTrust(0), ['low']);
	});

	test('branch with nothing that holds is stuck', () => {
		const p = talk({n1: {mode: 'branch', options: [
			{id: 'b1', if: [{type: 'flag', name: 'storm', value: true}], next: 'end'},
		]}});
		const st = D.newState(p);
		assert.deepEqual(play(D.start(p, 't', st)), [{type: 'stuck', node: 'n1', reason: 'no-branch'}, {type: 'end', dialogue: 't'}]);
		assert.equal(st.seen.t, 1);
	});

	test('random picks with opts.random, among the options that hold', () => {
		const p = talk({n1: {mode: 'random', options: [
			{id: 'r1', reply: [{who: 'mia', text: 'one'}], next: 'end'},
			{id: 'r2', if: [{type: 'flag', name: 'storm', value: true}], reply: [{who: 'mia', text: 'never'}], next: 'end'},
			{id: 'r3', reply: [{who: 'mia', text: 'three'}], next: 'end'},
			{id: 'r4', reply: [{who: 'mia', text: 'four'}], next: 'end'},
		]}});
		const pick = r => said(play(D.start(p, 't', null, {random: () => r})))[0];
		assert.equal(pick(0), 'one');
		assert.equal(pick(0.5), 'three');
		assert.equal(pick(0.999), 'four');
		assert.equal(pick(1), 'four');
	});

	describe('give', () => {
		const p = talk({
			n1: {
				lines: [{who: 'mia', text: 'Got anything?'}],
				mode: 'give',
				ask: {item: 'rose', text: 'something red'},
				options: [
					{id: 'g1', if: [{type: 'given_asked'}], reply: [{who: 'mia', text: 'asked'}], next: 'n2'},
					{id: 'g2', if: [{type: 'given_liked'}], reply: [{who: 'mia', text: 'liked'}], next: 'n2'},
					{id: 'g3', if: [{type: 'given_tag', tags: ['drink']}], reply: [{who: 'mia', text: 'tag'}], next: 'n2'},
					{id: 'g4', if: [{type: 'given_none'}], reply: [{who: 'mia', text: 'none'}], next: 'n2'},
					{id: 'g5', reply: [{who: 'mia', text: 'else'}], next: 'n2'},
				],
			},
			// (what was given keeps holding after the give node)
			n2: {mode: 'branch', options: [
				{id: 'b1', if: [{type: 'given', is: ['rose']}], reply: [{who: 'mia', text: 'still a rose'}], next: 'end'},
				{id: 'b2', if: [{type: 'given_not', is: ['rose']}], reply: [{who: 'mia', text: 'still not a rose'}], next: 'end'},
				{id: 'b3', next: 'end'},
			]},
		});

		test('it asks, waits, and tells what was given', () => {
			const run = D.start(p, 't');
			assert.equal(run.next().type, 'line');
			const ev = run.next();
			assert.deepEqual(ev, {type: 'give', node: 'n1', ask: {item: 'rose', text: 'something red'}});
			assert.deepEqual(run.next(), ev, 'the same event again while it waits');
			assert.throws(() => run.choose('g1'), /Nothing to choose/);
			run.give('rose');
			assert.deepEqual(run.next(), {type: 'given', node: 'n1', item: 'rose'});
		});

		test('the answer depends on what was given, and keeps holding later', () => {
			const answer = item => said(play(D.start(p, 't'), [item])).slice(1);
			assert.deepEqual(answer('rose'), ['asked', 'still a rose']);
			assert.deepEqual(answer('espresso'), ['liked', 'still not a rose']);
			assert.deepEqual(answer('lemonade'), ['tag', 'still not a rose']);
			assert.deepEqual(answer('pebble'), ['else', 'still not a rose']);
			assert.deepEqual(answer(null), ['none']);
			assert.deepEqual(answer(''), ['none']);
		});

		test('giving does not take the item away by itself', () => {
			const st = D.newState(p);
			play(D.start(p, 't', st), ['espresso']);
			assert.equal(st.items.espresso, 2);
		});

		test('an ask with no item and no text', () => {
			const q = talk({n1: {mode: 'give', options: [{id: 'g1', next: 'end'}]}});
			assert.deepEqual(D.start(q, 't').next(), {type: 'give', node: 'n1', ask: {item: '', text: ''}});
		});

		test('stuck when no answer holds', () => {
			const q = talk({n1: {mode: 'give', ask: {item: 'rose'}, options: [{id: 'g1', if: [{type: 'given_asked'}], next: 'end'}]}});
			const events = play(D.start(q, 't'), [null]);
			assert.deepEqual(kinds(events), ['give', 'given', 'stuck', 'end']);
			assert.equal(events[2].reason, 'no-branch');
		});
	});

	test('a loop of empty blocks ends as stuck instead of hanging', async () => {
		// In a worker: a runner that loops forever never yields, so only terminating it can fail the test.
		const result = await inWorker(5000, `
			const {parentPort, workerData} = require('node:worker_threads');
			const D = require(workerData.runtime);
			const playAll = (nodes, start) => {
				const p = {dialogues: [{id: 't', character: 'mia', start, nodes}]};
				const st = D.newState(p);
				const run = D.start(p, 't', st);
				const events = [];
				for (let ev = run.next(); events.push(ev), ev.type !== 'end'; ev = run.next());
				return {events, seen: st.seen.t};
			};
			parentPort.postMessage([
				playAll({a: {mode: 'line', next: 'b'}, b: {mode: 'line', next: 'a'}}, 'a'),
				playAll({a: {mode: 'branch', options: [{id: 'o1', next: 'a'}]}}, 'a'),
			]);
		`);
		for (const {events, seen} of result) {
			assert.deepEqual(events.map(e => e.type), ['stuck', 'end']);
			assert.equal(events[0].reason, 'loop');
			assert.equal(seen, 1);
		}
	});

	test('seen counts every time a talk ends', () => {
		const p = talk({n1: {lines: [{who: 'mia', text: 'Hi.'}], mode: 'line', next: 'end'}});
		const st = D.newState(p);
		play(D.start(p, 't', st));
		assert.equal(st.seen.t, 1);
		play(D.start(p, 't', st));
		assert.equal(st.seen.t, 2);
	});

	test('missing mode means line, missing next means end, a missing node ends the talk', () => {
		const p = talk({
			n1: {lines: [{who: 'mia', text: 'One.'}], next: 'n2'},
			n2: {lines: [{who: 'mia', text: 'Two.'}], next: 'nowhere'},
			n3: {lines: [{who: 'mia', text: 'Three.'}]},
		});
		assert.deepEqual(said(play(D.start(p, 't'))), ['One.', 'Two.']);
		assert.deepEqual(said(play(D.start(p, 't', null, {node: 'n3'}))), ['Three.']);
	});

	test('start takes an id or the dialogue itself, and makes a state if none is given', () => {
		const p = talk({n1: {lines: [{who: 'mia', text: 'Hi.'}], mode: 'line', next: 'end'}});
		assert.deepEqual(said(play(D.start(p, p.dialogues[0]))), ['Hi.']);
		const run = D.start(p, 't');
		assert.equal(run.state.place, 'cafe');
		assert.throws(() => D.start(p, 'nope'), /No dialogue nope/);
	});

	test('a game\'s own conditions work inside a run', () => {
		const p = talk({n1: {mode: 'choice', options: [
			{id: 'o1', text: 'Sunny', if: [{type: 'weather', is: 'sunny'}], next: 'end'},
			{id: 'o2', text: 'Rainy', if: [{type: 'weather', is: 'rainy'}], next: 'end'},
		]}});
		const conditions = {weather: c => c.is === 'sunny'};
		assert.deepEqual(D.start(p, 't', null, {conditions}).next().options.map(o => o.id), ['o1']);
	});
});

// ---------------------------------------------------------------- words in the text

describe('fill', () => {
	const p = project();

	test('{player}, {name} and {item}', () => {
		const text = '{player}, meet {name}. {item}! {name} again.';
		assert.equal(D.fill(text, p, {owner: 'mia', given: 'rose'}), 'Sam, meet Mia. Rose! Mia again.');
	});

	test('{item}: what was given, or else what was asked for', () => {
		assert.equal(D.fill('{item}', p, {asked: 'espresso'}), 'Espresso');
		assert.equal(D.fill('{item}', p, {given: null, asked: 'espresso'}), 'Espresso');
		assert.equal(D.fill('{item}', p, {given: 'rose', asked: 'espresso'}), 'Rose');
		assert.equal(D.fill('{item}', p, {given: 'pebble'}), 'pebble');
		assert.equal(D.fill('[{item}]', p, {}), '[]');
	});

	test('names nobody gave', () => {
		assert.equal(D.fill('{player} and {name}', {characters: []}, {owner: 'mia'}), 'player and mia');
		assert.equal(D.fill(undefined, p), '');
	});

	test('in a run: a give block\'s own lines can name what it asks for', () => {
		const q = talk({n1: {
			lines: [{who: 'mia', text: 'Bring me a {item}, {player}.'}],
			mode: 'give',
			ask: {item: 'rose'},
			options: [{id: 'g1', reply: [{who: 'mia', text: 'A {item}. Thanks.'}], next: 'end'}],
		}});
		const run = D.start(q, 't');
		assert.equal(run.fill(run.next().text), 'Bring me a Rose, Sam.');
		run.next();
		run.give('espresso');
		run.next();
		assert.equal(run.fill(run.next().text), 'A Espresso. Thanks.');
	});
});

// ---------------------------------------------------------------- which talks can start

describe('available', () => {
	const p = project([
		{id: 'a', character: 'mia', status: 'ready', places: ['cafe'], if: [{type: 'phase', is: ['morning']}], start: 'n1', nodes: {}},
		{id: 'b', character: 'mia', status: 'draft', start: 'n1', nodes: {}},
		{id: 'c', character: 'leo', status: 'ready', places: ['beach'], repeat: true, start: 'n1', nodes: {}},
		{id: 'd', character: 'leo', status: 'ready', if: [{type: 'flag', name: 'storm', value: true}], start: 'n1', nodes: {}},
		{id: 'e', character: 'leo', status: 'ready', places: ['cafe'], if: [{type: 'stat', stat: 'trust', op: '==', value: 1}], start: 'n1', nodes: {}},
	]);
	const ids = (st, q) => D.available(p, st, q).map(d => d.id);

	test('in the file\'s order, where the player is, conditions checked for the talk\'s character', () => {
		// (e: Leo's trust is 1, Mia's would be 3)
		assert.deepEqual(ids(D.newState(p)), ['a', 'b', 'e']);
	});

	test('places: the state\'s, or the one asked about; none means anywhere', () => {
		assert.deepEqual(ids(D.newState(p), {place: 'beach'}), ['b', 'c']);
		const st = D.newState(p);
		st.place = 'beach';
		assert.deepEqual(ids(st), ['b', 'c']);
	});

	test('character and status filters', () => {
		const st = D.newState(p);
		assert.deepEqual(ids(st, {character: 'leo', place: 'beach'}), ['c']);
		assert.deepEqual(ids(st, {status: 'ready'}), ['a', 'e']);
		assert.deepEqual(ids(st, {status: 'draft'}), ['b']);
	});

	test('seen talks only come back when they repeat', () => {
		const st = D.newState(p);
		st.seen = {a: 1, c: 3};
		assert.deepEqual(ids(st), ['b', 'e']);
		assert.deepEqual(ids(st, {place: 'beach'}), ['b', 'c']);
	});

	test('conditions', () => {
		const st = D.newState(p);
		st.hour = 13;
		st.flags.storm = true;
		assert.deepEqual(ids(st), ['b', 'd', 'e']);
	});

	test('a game\'s own conditions', () => {
		const q = project([{id: 'x', character: 'mia', if: [{type: 'weather', is: 'sunny'}], start: 'n1', nodes: {}}]);
		assert.deepEqual(D.available(q, D.newState(q)).map(d => d.id), []);
		assert.deepEqual(D.available(q, D.newState(q), {conditions: {weather: c => c.is === 'sunny'}}).map(d => d.id), ['x']);
	});
});

// ---------------------------------------------------------------- the example project

describe('examples/cafe.json', () => {
	const p = cafe;
	const idSet = list => new Set((list || []).map(x => x.id));
	const chars = idSet(p.characters);
	const items = idSet(p.items);
	const places = idSet(p.places);
	const stats = idSet(p.stats);
	const phases = idSet(p.time.phases);
	const weekdays = idSet(p.time.weekdays);
	const talks = idSet(p.dialogues);
	const tags = new Set(p.items.flatMap(i => i.tags || []));

	test('is a version 1 Dialogos file', () => {
		assert.equal(p.format, 'dialogos');
		assert.equal(p.version, D.FORMAT_VERSION);
	});

	test('every id it names exists', () => {
		const problems = [];
		const need = (set, id, what, where) => { if (!set.has(id)) problems.push(`${where}: no ${what} "${id}"`); };
		const cond = (c, where) => {
			if (!D.CONDITIONS[c.type]) problems.push(`${where}: unknown condition ${c.type}`);
			if (c.stat) need(stats, c.stat, 'stat', where);
			if (c.who) need(chars, c.who, 'character', where);
			if (c.type === 'relation') for (const k of ['from', 'to']) need(chars, c[k], 'character', where);
			if (c.type === 'item') need(items, c.item, 'item', where);
			if (c.type === 'seen') need(talks, c.dialogue, 'dialogue', where);
			const pool = {weekday: weekdays, phase: phases, place: places, given: items, given_not: items}[c.type];
			if (pool) for (const id of c.is) need(pool, id, c.type, where);
			if (c.type === 'given_tag') for (const t of c.tags) need(tags, t, 'tag', where);
		};
		const effect = (e, where) => {
			if (e.stat) need(stats, e.stat, 'stat', where);
			if (e.who) need(chars, e.who, 'character', where);
			if (e.type === 'relation') for (const k of ['from', 'to']) need(chars, e[k], 'character', where);
			if (e.type === 'item') need(items, e.item, 'item', where);
			if (e.type === 'place') need(places, e.place, 'place', where);
		};
		const lines = (list, where) => {
			for (const ln of list || []) {
				if (ln.who === D.NARRATOR) continue;
				need(chars, ln.who, 'character', where);
				const c = p.characters.find(x => x.id === ln.who);
				if (ln.mood && c && !(c.moods || []).includes(ln.mood)) problems.push(`${where}: ${ln.who} has no mood ${ln.mood}`);
			}
		};
		need(places, p.time.start.place, 'place', 'time.start');
		for (const c of p.characters) {
			for (const id of [...(c.likes || []), ...(c.dislikes || [])]) need(items, id, 'item', c.id);
			for (const s of Object.keys(c.stats || {})) need(stats, s, 'stat', c.id);
			for (const r of c.relations || []) need(chars, r.to, 'character', c.id);
		}
		for (const d of p.dialogues) {
			need(chars, d.character, 'character', d.id);
			for (const pl of d.places || []) need(places, pl, 'place', d.id);
			for (const c of d.if || []) cond(c, d.id);
			for (const [id, n] of Object.entries(d.nodes)) {
				const where = `${d.id}/${id}`;
				lines(n.lines, where);
				for (const e of n.effects || []) effect(e, where);
				if (n.ask && n.ask.item) need(items, n.ask.item, 'item', where);
				for (const o of n.options || []) {
					for (const c of o.if || []) cond(c, `${where}/${o.id}`);
					for (const e of o.effects || []) effect(e, `${where}/${o.id}`);
					lines(o.reply, `${where}/${o.id}`);
				}
			}
		}
		assert.deepEqual(problems, []);
	});

	test('every next resolves, and every node can be reached', () => {
		for (const d of p.dialogues) {
			assert.ok(d.nodes[d.start], `${d.id}: start ${d.start}`);
			const optionIds = new Set();
			for (const [id, n] of Object.entries(d.nodes)) {
				const where = `${d.id}/${id}`;
				if (n.mode === 'line') {
					assert.ok(!n.options, `${where}: a line node with options`);
					assert.ok(n.next === D.END || d.nodes[n.next], `${where}: next ${n.next}`);
				} else {
					assert.ok(n.options && n.options.length && !('next' in n), `${where}: ${n.mode} needs options and no next`);
					for (const o of n.options) {
						assert.ok(!optionIds.has(o.id), `${where}: option id ${o.id} twice`);
						optionIds.add(o.id);
						const ok = o.next === D.END || (o.next === D.BACK && n.mode === 'choice') || d.nodes[o.next];
						assert.ok(ok, `${where}/${o.id}: next ${o.next}`);
					}
				}
			}
			const reached = new Set();
			const walk = id => {
				if (reached.has(id) || !d.nodes[id]) return;
				reached.add(id);
				const n = d.nodes[id];
				(n.mode === 'line' ? [n.next] : n.options.map(o => o.next)).forEach(walk);
			};
			walk(d.start);
			assert.deepEqual([...reached].sort(), Object.keys(d.nodes).sort(), `${d.id}: unreachable nodes`);
		}
	});

	test('every talk plays to its end, always picking the first option', () => {
		const firstItem = p.items[0].id;
		for (const d of p.dialogues) {
			for (const gift of [firstItem, null]) {
				for (const r of [0, 0.999]) {
					const st = D.newState(p);
					const run = D.start(p, d.id, st, {random: () => r});
					const where = `${d.id} (gift ${gift}, random ${r})`;
					let ev;
					let steps = 0;
					for (ev = run.next(); ev.type !== 'end'; ev = run.next()) {
						assert.ok(++steps < 500, `${where}: does not end`);
						assert.notEqual(ev.type, 'stuck', `${where}: stuck at ${ev.node} (${ev.reason})`);
						if (ev.node) assert.ok(d.nodes[ev.node], `${where}: event in a missing node ${ev.node}`);
						if (ev.type === 'line') assert.doesNotMatch(run.fill(ev.text), /\{(player|name|item)\}/, where);
						if (ev.type === 'choice') run.choose(ev.options[0].id);
						if (ev.type === 'give') run.give(gift);
					}
					assert.equal(ev.dialogue, d.id);
					assert.equal(st.seen[d.id], 1, where);
				}
			}
		}
	});

	test('the story can start: on day one at the café only the opening talk is ready', () => {
		const st = D.newState(p);
		assert.deepEqual(D.available(p, st, {status: 'ready'}).map(d => d.id), ['mia_first_day']);
		play(D.start(p, 'mia_first_day', st), ['o4']);
		st.hour = 9;
		assert.deepEqual(D.available(p, st, {status: 'ready'}).map(d => d.id), ['leo_usual']);
	});
});
