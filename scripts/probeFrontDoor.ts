import { Career } from '../src/career/Career';
import { SaveManager } from '../src/career/SaveManager';
import { MemoryDriver, ProfileStore } from '../src/profile/ProfileStore';
import { defaultHelmet, driverCode } from '../src/career/Identity';

/**
 * THE FRONT DOOR: a first run, an identity, and more than one of them.
 *
 * WHY THIS PROBE EXISTS, IN THE WORDS OF THE PERSON WHO PLAYED IT:
 *
 *   "imagine this is a game. rn its on a local host, but imagine if I logged
 *    into the website for the first time, what would i see? rn it seems that i
 *    am logging in with Preet Karia somehow, but in the future how would we do
 *    that... do I need to logout someway or some form?"
 *
 * They were right and the answer was worse than they thought: there was no
 * identity system at all. The name on the front page was a string typed into a
 * career-creation form, written into a career save, and read back out — so the
 * game greeted a stranger by somebody else's name, offered no way to be a
 * second person, and had nothing to leave.
 *
 * Everything below is the part of that fix a browser cannot check cheaply: the
 * state machine underneath the screens. `regress:career` drives the SCREENS,
 * including the first-run path and the skip button; this proves the store they
 * are all asking.
 *
 * It runs with an in-memory driver rather than `localStorage`, which is why it
 * runs in node at all — and, more usefully, is why a first run can be created
 * on demand instead of by hand-emptying a browser.
 */

let failures = 0;
function check(ok: boolean, msg: string, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

const ID = {
  firstName: 'Ondrej',
  lastName: 'Zdravkovic',
  nationality: 'Czechia',
  raceNumber: 63,
};
const SECOND = {
  firstName: 'Mei',
  lastName: 'Takahashi',
  nationality: 'Japan',
  raceNumber: 21,
};

/**
 * Empties the career store.
 *
 * NECESSARY, AND THE REASON IS WORTH KNOWING. Outside a browser `SaveManager`
 * falls back to a module-level map, so every `new SaveManager()` in this file
 * shares one set of careers. Without this, the second case in this probe
 * inherits the first case's saves — and because `ProfileStore` ADOPTS orphaned
 * careers on construction (which is the whole upgrade path, see case 6), those
 * inherited saves arrive as extra drivers on the rack and every count below is
 * wrong. The failure looks like a bug in switching drivers and is a bug in the
 * test; leaving it in would have made a real regression here invisible.
 */
function wipeSaves(saves: SaveManager): void {
  for (const slot of saves.listSaves()) saves.deleteSave(slot.id);
}

/** A store with nothing in it and nothing under it. */
function freshStore(): { store: ProfileStore; saves: SaveManager } {
  const saves = new SaveManager();
  wipeSaves(saves);
  const store = new ProfileStore({ saves, driver: new MemoryDriver() });
  return { store, saves };
}

// ===========================================================================
// 1. A genuinely first run
// ===========================================================================

console.log('\nThe front door — a browser nobody has ever played on');

{
  const { store } = freshStore();
  check(store.isFirstRun, 'a store with no drivers reports a first run');
  check(store.active === null, 'and nobody is playing');
  check(store.list().length === 0, 'and the rack is empty');
  check(store.currentCareer() === null, 'so there is nothing to continue');
  // The record has to be answerable before there is anybody to have one, or
  // the menu cannot draw at all on the one screen that matters most.
  const r = store.record();
  check(r.starts === 0 && r.wins === 0 && r.bestFinish === 0,
    'a record can be read with no driver, and is empty');
}

// ===========================================================================
// 2. Making a driver
// ===========================================================================

console.log('\nMaking a driver');

{
  const { store } = freshStore();
  const helmet = defaultHelmet(20260802);
  const me = store.create({ ...ID, helmet });

  check(!store.isFirstRun, 'the browser is no longer on a first run');
  check(store.active?.id === me.id, 'the new driver is the one playing');
  check(store.active?.firstName === ID.firstName, 'their given name is theirs');
  check(store.active?.lastName === ID.lastName, 'their surname is theirs');
  // The code is DERIVED here rather than taken from the caller, so the profile
  // and the timing tower cannot disagree about who this is.
  check(me.code === driverCode(ID.lastName), 'the three-letter code follows the surname', me.code);
  check(me.code === 'ZDR', 'and it is the one the timing tower would print', me.code);
  check(me.raceNumber === ID.raceNumber, 'their number is theirs');
  check(me.helmet.base === helmet.base && me.helmet.family === helmet.family,
    'their helmet is the one they designed');
  check(me.introSeen === false, 'a brand new driver has not seen the titles');
  check(me.careers.length === 0, 'and has no career yet');

  store.noteIntroSeen(me.id);
  check(store.get(me.id)?.introSeen === true, 'watching the titles is remembered');
}

// ===========================================================================
// 3. A career belongs to the driver who ran it
// ===========================================================================

console.log('\nA career belongs to a driver');

{
  const { store } = freshStore();
  store.create(ID);
  const career = Career.create({ ...ID, seed: 20260802 });
  store.saveCareer('career-1', career.state);

  const me = store.active!;
  check(me.careers.length === 1, 'saving a career files it under the driver');
  check(store.currentCareer()?.id === 'career-1', 'and it is the one Continue offers');
  check(store.currentCareer()?.tier === career.state.tier,
    'the summary carries the tier', String(store.currentCareer()?.tier));
  check(store.currentCareer()?.seasonYear === career.state.season.year,
    'and the season');

  const back = store.loadCareer('career-1');
  check(back.ok, 'the career loads back', back.ok ? '' : back.reason);
  check(back.ok && back.state.player.lastName === ID.lastName,
    'with its driver');

  // A SECOND CAREER FOR THE SAME DRIVER. This is the other half of "more than
  // one save": the same person, two runs at the ladder.
  const second = Career.create({ ...ID, seed: 99 });
  store.saveCareer('career-2', second.state);
  check(store.active!.careers.length === 2, 'a driver can hold two careers');
  check(store.currentCareer()?.id === 'career-2',
    'and Continue offers the one most recently played');

  // Going back to the first one has to move it back to the front, or Continue
  // sends the player to the career they just left.
  store.touchCareer('career-1');
  check(store.currentCareer()?.id === 'career-1',
    'opening the older one makes it current again');
}

// ===========================================================================
// 4. Two drivers, and leaving one
// ===========================================================================

console.log('\nSwitching driver, and deleting one');

{
  const { store, saves } = freshStore();
  const a = store.create(ID);
  store.saveCareer('career-a', Career.create({ ...ID, seed: 1 }).state);

  const b = store.create(SECOND);
  check(store.active?.id === b.id, 'making a second driver switches to them');
  check(store.list().length === 2, 'both are on the rack');
  check(store.currentCareer() === null,
    'the new driver starts with no career, not with the old one’s');

  store.saveCareer('career-b', Career.create({ ...SECOND, seed: 2 }).state);
  check(store.get(a.id)!.careers.length === 1, 'the first driver still has theirs');
  check(store.get(b.id)!.careers.length === 1, 'and the second has their own');

  store.setActive(a.id);
  check(store.active?.id === a.id, 'switching back works');
  check(store.currentCareer()?.id === 'career-a',
    'and Continue points at THAT driver’s career');

  // DELETING TAKES THE CAREERS WITH IT. Leaving them behind would strand a
  // save on the device belonging to nobody, reachable by no screen and taking
  // quota for ever.
  store.remove(b.id);
  check(store.list().length === 1, 'deleting a driver removes them');
  check(saves.loadResult('career-b').ok === false,
    'and their career is gone from disk too');
  check(saves.loadResult('career-a').ok === true,
    'while the other driver’s career is untouched');
  check(store.active?.id === a.id, 'the driver still playing is unaffected');

  // Deleting the LAST driver has to land somewhere valid rather than leaving a
  // dangling active id, because the shell reads `active` on every screen.
  store.remove(a.id);
  check(store.active === null, 'deleting the last driver leaves nobody playing');
  check(store.isFirstRun, 'and the browser is back to a first run');
}

// ===========================================================================
// 5. Erase everything
// ===========================================================================

console.log('\nErasing everything');

{
  const { store, saves } = freshStore();
  store.create(ID);
  store.saveCareer('c1', Career.create({ ...ID, seed: 1 }).state);
  store.create(SECOND);
  store.saveCareer('c2', Career.create({ ...SECOND, seed: 2 }).state);

  store.removeAll();
  check(store.isFirstRun, 'erasing everything returns the browser to a first run');
  check(store.list().length === 0, 'no drivers are left');
  check(!saves.loadResult('c1').ok && !saves.loadResult('c2').ok,
    'and no careers are left either');
}

// ===========================================================================
// 6. The upgrade path: careers that existed before profiles did
// ===========================================================================

console.log('\nAdopting careers from before this existed');

{
  // The situation on the machine that reported the fault: a career written by
  // an older build, and no profile index at all. The player must open the game
  // and find their driver already there — not an empty rack and a form.
  const saves = new SaveManager();
  wipeSaves(saves);
  const career = Career.create({ ...ID, seed: 4242 });
  saves.save('legacy-1', career.state);

  const store = new ProfileStore({ saves, driver: new MemoryDriver() });
  check(!store.isFirstRun, 'an install with careers is not treated as a first run');
  check(store.list().length === 1, 'the career became a driver');
  check(store.active?.lastName === ID.lastName,
    'under the name the career was played as', store.active?.lastName);
  check(store.active?.raceNumber === ID.raceNumber, 'with their number');
  check(store.active?.code === 'ZDR', 'and their code');
  check(store.currentCareer()?.id === 'legacy-1',
    'and Continue points straight back at the career');
  check(store.active?.introSeen === true,
    'somebody mid-career is not shown a title sequence they have already skipped');
}

// ===========================================================================
// 7. A corrupt index does not lock anybody out
// ===========================================================================

console.log('\nA damaged index');

{
  const saves = new SaveManager();
  wipeSaves(saves);
  saves.save('legacy-2', Career.create({ ...ID, seed: 7 }).state);
  const driver = new MemoryDriver();
  driver.write('f1sim.profiles', '{ this is not json');

  const store = new ProfileStore({ saves, driver });
  check(store.list().length === 1,
    'a corrupt profile index is rebuilt from the careers rather than fatal');
  check(store.active?.lastName === ID.lastName, 'and the driver comes back');
}

// ===========================================================================
// 8. The record is derived, so it cannot drift
// ===========================================================================

console.log('\nThe record');

{
  const { store } = freshStore();
  store.create(ID);
  const career = Career.create({ ...ID, seed: 31 });
  store.saveCareer('r1', career.state);
  check(store.record().starts === 0, 'a career with no races has no starts');

  // Saving the same career twice must not count anything twice. This is the
  // whole reason the record is recomputed from the save rather than
  // accumulated as results arrive.
  store.saveCareer('r1', career.state);
  store.saveCareer('r1', career.state);
  check(store.active!.careers.length === 1,
    'saving the same career repeatedly leaves one entry');
  check(store.record().starts === 0, 'and does not double-count anything');
}

console.log('');
if (failures > 0) {
  console.error(`probe:frontdoor — ${failures} check(s) failed`);
  process.exit(1);
}
console.log('probe:frontdoor — a first run, an identity, and a way to leave it.');
