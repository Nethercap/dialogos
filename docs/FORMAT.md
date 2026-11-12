# The Dialogos file format (version 1)

A Dialogos project is one JSON file. The editor writes it, a game reads it. Everything a game
needs to run the talks is in it: who talks, what they say, what the player can answer, when each
talk can happen and what it changes.

`schema/dialogos.schema.json` is the same thing as a JSON Schema, and `web/runtime.js` is a
small runner that follows this document to the letter (use it, or read it when porting).

Fields that would say nothing (empty text, empty lists, `false`) are left out of the file, so a
reader must treat a missing field as its default. One exception: in conditions and effects,
`value` is always written, because a missing `value` on a flag or `seen` means `true`.

## The whole file

```json
{
  "format": "dialogos",
  "version": 1,
  "title": "My game",
  "lang": "en",
  "stats": [],
  "time": {"start": {"day": 1, "hour": 8}, "phases": [], "weekdays": []},
  "places": [],
  "items": [],
  "flags": [],
  "limits": {"lineChars": 0, "optionChars": 0, "options": 0},
  "characters": [],
  "dialogues": []
}
```

| Field | What it is |
|---|---|
| `format`, `version` | Always `"dialogos"` and `1` for this document. |
| `title` | The project's name. |
| `lang` | The language the talks are written in (`"en"`, `"es"`…). |
| `stats` | The numbers the talks move: trust, romance, money… |
| `time` | Day count, the parts of the day, the weekdays. |
| `places`, `items`, `flags` | Lists the talks refer to. |
| `limits` | The editor's checks for the game's text box (0 = no check). The game may ignore them. |
| `characters` | Who talks, the player included. |
| `dialogues` | The talks. |

Every id is a string. Ids are what the file uses to point at things; names are only shown.

## Stats

```json
{"id": "romance", "name": "Romance", "scope": "character", "min": 0, "max": 10, "start": 0, "color": "#ff6fa8", "notes": ""}
```

- `scope: "character"`: each character has their own value (how they see the player: trust,
  romance, fear…). The same stats are used between two characters (see `relations`).
- `scope: "global"`: one value for the whole game (money, reputation, sanity…).
- `min`, `max` (optional): changes never go past them.
- `start`: where it begins, unless a character's sheet says otherwise.

## Time

```json
"time": {
  "start": {"day": 1, "hour": 8, "place": "cafe"},
  "phases": [
    {"id": "morning", "name": "Morning", "start": 6},
    {"id": "afternoon", "name": "Afternoon", "start": 12},
    {"id": "evening", "name": "Evening", "start": 18},
    {"id": "night", "name": "Night", "start": 22}
  ],
  "weekdays": [{"id": "mon", "name": "Monday"}, {"id": "tue", "name": "Tuesday"}]
}
```

- The game keeps a **day** number (starting at `start.day`, 1 by default) and an **hour** (0–23).
- A **phase** is the part of the day an hour falls in: the last phase whose `start` is at or
  before the hour. Before the first one it is still the last one (night, past midnight).
- **Weekdays** are optional. Day 1 is the first one on the list, day 2 the next, and round.
- `start.place` (optional): where the player is when the game starts.

A game that only has "day" and "night" turns can use two phases and never look at the hour.

## Places, items, flags

```json
{"id": "cafe", "name": "Café", "notes": ""}
{"id": "rose", "name": "Rose", "tags": ["flower", "gift"], "start": 0, "notes": ""}
{"id": "met_mia", "start": false, "notes": "Set by the game when..."}
```

- An item's `start` is how many the player has when the game starts. `tags` let a talk react to
  a kind of item ("anything with alcohol") instead of a list.
- Flags are on/off marks. Talks turn them on and off with effects; this list is for the ones the
  game sets itself (or that start on), so the editor knows they exist.

## Characters

```json
{
  "id": "mia",
  "name": "Mia",
  "group": "Main",
  "color": "#7ddc6f",
  "notes": "Who she is, how she talks...",
  "moods": ["happy", "sad", "angry"],
  "stats": {"trust": 2, "romance": 0},
  "likes": ["rose"],
  "dislikes": ["coffee"],
  "relations": [{"to": "leo", "label": "ex-boyfriend", "values": {"trust": -2}}]
}
```

- The player is the character with the id `"player"`; it is always there. Its name is what the
  player is called (you can rename it: "You", "Detective", "Bartender"…). What the player says
  is mostly the text of the options they pick.
- `"narrator"` is not a character, but can say lines: what happens without anyone saying it.
- `moods`: the faces or tones a line can have (the game picks the portrait or the voice).
- `stats`: where each `character` stat starts for them.
- `likes`, `dislikes`: items, for the conditions `given_liked` and `given_disliked`.
- `relations`: how they see another character. `values` are where the stats start between the
  two; `label` is only a note ("her boss", "owes him money").

## Dialogues

```json
{
  "id": "mia_coffee",
  "character": "mia",
  "title": "Coffee with Mia",
  "status": "draft",
  "places": ["cafe"],
  "required": false,
  "repeat": false,
  "if": [{"type": "phase", "is": ["morning"]}],
  "notes": "",
  "start": "n1",
  "nodes": {"n1": {}, "n2": {}}
}
```

- `character`: whose talk it is. Conditions and effects that name no one mean this character.
- `status`: `"draft"` (also when missing) or `"ready"`. The game decides what to do with drafts.
- `places`: where it can happen. Empty or missing: anywhere.
- `required`: a story talk that must happen (a note for the game: the format doesn't enforce it).
- `repeat`: it can happen again after it has been seen once.
- `if`: conditions that must all hold for it to start (see below).
- `start`: the id of the first node. `nodes`: the talk's blocks, by id.

The order of `dialogues` is the order the writer wants them for each character: when more than
one can start, a game should prefer the first.

## Nodes

A node is a block of lines followed by what happens next:

```json
{
  "lines": [{"who": "mia", "text": "You're late again.", "mood": "angry"}],
  "effects": [],
  "mode": "choice",
  "options": []
}
```

- `lines`: said one after the other. `who`: a character's id, `"player"` or `"narrator"`.
  `mood` (optional): one of that character's moods.
- `effects`: applied once the lines are said.
- `mode`: what comes after the lines:

| mode | What happens |
|---|---|
| `"line"` | Nothing to choose: go on to `next` (a node id, or `"end"`). |
| `"choice"` | The player picks one of the `options` whose conditions hold. |
| `"give"` | The talk waits for the player to give (or show) an item, or nothing; then the first of the `options` that holds. `ask: {"item": "rose", "text": "something sweet"}` (both optional) is what the character asks for. |
| `"branch"` | No choice: the first of the `options` that holds. |
| `"random"` | No choice: one at random of the `options` that hold. |

In `branch` and `give`, an option with no conditions holds always: put it last, as the "else".
When nothing holds (or a choice has no option left) the talk ends there.

## Options

```json
{
  "id": "o1",
  "text": "Sorry, the bus...",
  "if": [{"type": "stat", "stat": "trust", "op": ">=", "value": 3}],
  "effects": [{"type": "stat", "stat": "trust", "delta": -1}],
  "reply": [{"who": "mia", "text": "There's always a bus."}],
  "next": "end"
}
```

- `id`: unique within the dialogue.
- `text`: what the player says (only in `choice`).
- `if`: all must hold for the option to be offered (or the branch taken).
- `effects`: applied when it is picked, before `reply`.
- `reply`: lines said after it.
- `next`: a node id, `"end"`, or `"back"` (only in `choice`: offer the same options again,
  without the ones already picked in this talk).

An option picked once isn't offered again in the same talk, however the talk comes back to its
node. It is offered again the next time the talk starts.

## Conditions

Every condition is an object with a `type`. `op` is one of `>=`, `<=`, `==`, `!=`, `>`, `<`.

| type | Fields | Holds when |
|---|---|---|
| `stat` | `stat`, `who`, `op`, `value` | The stat compares to the value. `who` is left out for global stats; for character stats a missing `who` means the talk's character. |
| `relation` | `stat`, `from`, `to`, `op`, `value` | How `from` sees `to` compares to the value. |
| `flag` | `name`, `value` | The flag is on (`value: true`) or off (`false`). |
| `item` | `item`, `op`, `value` | How many the player has compares to the value. |
| `day` | `op`, `value` | The day number compares to the value. |
| `weekday` | `is` (weekday ids) | Today is one of them. |
| `phase` | `is` (phase ids) | The hour falls in one of them. |
| `hour` | `from`, `to` | `from` ≤ hour < `to`; past midnight when `from` > `to` (20 to 2). |
| `place` | `is` (place ids) | The player is in one of them. |
| `seen` | `dialogue`, `value` | That talk has (`true`) or hasn't (`false`) been seen to its end. |
| `given` | `is` (item ids) | In a `give` node: the item given is one of them. |
| `given_not` | `is` | Something was given, and it's none of them. |
| `given_tag` | `tags` | The item given has one of the tags. |
| `given_liked` | — | The item given is one the talk's character likes. |
| `given_disliked` | — | The item given is one they dislike. |
| `given_asked` | — | The item given is the one asked for (`ask.item`). |
| `given_none` | — | The player gave nothing. |

The `given…` conditions only hold after a `give` node, and keep holding for the rest of the talk.

## Effects

| type | Fields | Does |
|---|---|---|
| `stat` | `stat`, `who`, `delta` | Adds `delta` (can be negative) to the stat, within its `min` and `max`. `who` as in conditions. |
| `relation` | `stat`, `from`, `to`, `delta` | The same, between two characters. |
| `flag` | `name`, `value` | Turns a flag on or off. |
| `item` | `item`, `delta` | Gives (+) or takes (−) items; never below 0. Giving an item in a `give` node doesn't take it away by itself: add `{"type": "item", "item": "rose", "delta": -1}` when it should. |
| `time` | `unit`, `amount` | Time goes forward: `"hours"`, `"phases"` (to the start of the next part of the day) or `"days"`. |
| `place` | `place` | The player is now in that place. |
| `event` | `name`, `text` | Nothing in the state: something for the game to do. `name` is for code (`"play_music"`, `"open_shop"`), `text` says it in words. |

## Words in the text

Lines and options can carry `{player}` (the player's name), `{name}` (the talk's character) and
`{item}` (the item given, or else the one asked for). The game swaps them when showing the text.

## Running a talk

1. Pick a talk that can start: its `if` holds, it is for this `place` (or any), and it's
   `repeat` or not yet seen. `runtime.js` has `available(project, state, {character, place})`.
2. Go into its `start` node: say its lines, apply its effects, then follow its `mode`.
3. An option: apply its effects, say its `reply`, then go to its `next`.
4. At `"end"` (or when nothing holds) the talk is over: count it as seen.

The state a game keeps is small: each stat's value (per character, per pair, or global), the
flags that are on, how many of each item the player has, which talks were seen and how many
times, the day, the hour and the place. `newState(project)` in `runtime.js` builds it from the
file.
