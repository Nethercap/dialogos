'use strict';
// Where the project lives: the file dialogos.py serves, or this browser (and a file on disk, where
// the browser lets a page write one).

const LOCAL_KEY = 'dialogos.project';
const LOCAL_NAME = 'dialogos.fileName';

const JSON_TYPES = [{description: 'Dialogos project', accept: {'application/json': ['.json']}}];

class ServerStore {
	constructor(info) {
		this.kind = 'server';
		this.path = info.file;
		this.rev = '';
	}

	static async detect() {
		if (location.protocol === 'file:') return null;
		try {
			const res = await fetch('api/ping', {cache: 'no-store'});
			if (!res.ok) return null;
			const info = await res.json();
			return info.app === 'dialogos' ? new ServerStore(info) : null;
		} catch (e) {
			return null;
		}
	}

	// The project, or null when the file doesn't exist yet.
	async load() {
		const res = await fetch('api/data', {cache: 'no-store'});
		const body = await res.json();
		if (!res.ok) throw new Error(body.error || res.status);
		this.rev = body.rev;
		this.path = body.path;
		return body.data;
	}

	// {ok} or {conflict} (the file changed by other hands); throws when the server can't be reached.
	async save(text, force) {
		const res = await fetch('api/data', {
			method: 'POST', headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({rev: this.rev, text, force: !!force}),
		});
		const body = await res.json();
		if (res.status === 409) return {conflict: true};
		if (!res.ok) throw new Error(body.error || res.status);
		this.rev = body.rev;
		return {ok: true};
	}

	// Whether the file on disk is still what this page last saw.
	async unchanged() {
		const {rev} = await (await fetch('api/rev', {cache: 'no-store'})).json();
		return rev === this.rev;
	}

	label() {
		return this.path;
	}
}

class BrowserStore {
	constructor() {
		this.kind = 'browser';
		this.handle = null;
		this.fileName = '';
		this.lastText = null;
		this.fileError = null;
	}

	get canLink() {
		return typeof window.showSaveFilePicker === 'function';
	}

	load() {
		try {
			const raw = localStorage.getItem(LOCAL_KEY);
			this.lastText = raw;
			return raw ? JSON.parse(raw) : null;
		} catch (e) {
			return null;
		}
	}

	async save(text) {
		let local = true;
		try {
			localStorage.setItem(LOCAL_KEY, text);
			this.lastText = text;
		} catch (e) {
			local = false;
		}
		this.fileError = null;
		if (this.handle) {
			try {
				const w = await this.handle.createWritable();
				await w.write(text);
				await w.close();
			} catch (e) {
				this.fileError = e;
			}
		}
		if (!local && !this.handle) throw new Error('storage');
		return {ok: true};
	}

	link(handle, name) {
		this.handle = handle;
		this.fileName = name || (handle && handle.name) || '';
		try { localStorage.setItem(LOCAL_NAME, this.fileName); } catch (e) { /* (only a label) */ }
	}

	// Another tab wrote the project: the text it wrote, if it isn't ours.
	foreignChange(ev) {
		if (ev.key !== LOCAL_KEY || ev.newValue === null || ev.newValue === this.lastText) return null;
		return ev.newValue;
	}

	label() {
		return this.handle ? this.fileName : '';
	}
}

// A JSON file the person picks: {text, name, handle} (handle only where the browser can write back).
function pickFile() {
	if (typeof window.showOpenFilePicker === 'function') {
		return window.showOpenFilePicker({types: JSON_TYPES}).then(async ([handle]) => {
			const f = await handle.getFile();
			return {text: await f.text(), name: f.name, handle};
		}, e => {
			if (e && e.name === 'AbortError') return null;
			throw e;
		});
	}
	return new Promise(resolve => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json,application/json';
		input.onchange = async () => {
			const f = input.files[0];
			resolve(f ? {text: await f.text(), name: f.name, handle: null} : null);
		};
		input.oncancel = () => resolve(null);
		input.click();
	});
}

// A place on disk to save to, where the browser allows it: the handle, or null.
async function pickSaveFile(suggested) {
	try {
		return await window.showSaveFilePicker({suggestedName: suggested, types: JSON_TYPES});
	} catch (e) {
		if (e && e.name === 'AbortError') return null;
		throw e;
	}
}

function download(text, name, type) {
	const url = URL.createObjectURL(new Blob([text], {type: type || 'application/json'}));
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
