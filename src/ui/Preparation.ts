import './briefing.css';
import './myteam.css';
import type { Career } from '../career/Career';
import { DEPARTMENT_IDS, DEPARTMENT_NAME } from '../career/MyTeam';

/**
 * WHAT YOU DO BETWEEN RACES.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCREEN EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * `Career.spendPrepSlot` has existed, fully implemented and documented, and was
 * REACHABLE FROM NOWHERE. Every one of its five branches moves something the
 * simulation reads — a driver attribute the AI's own model uses, a department
 * morale that decides what an upgrade costs and whether it passes quality
 * control, a fan rating that decides commercial income — and none of it could be
 * touched by anybody playing the game. It is the clearest possible example of
 * the thing this whole career mode keeps being accused of: a system that is
 * built, correct, and invisible.
 *
 * ---------------------------------------------------------------------------
 * EVERY OPTION STATES ITS CONSEQUENCE, AND THE CONSEQUENCE IS THE REAL ONE
 * ---------------------------------------------------------------------------
 *
 * Not "improves your driving" — "+0.4 to +1.6 on the attribute, permanently, and
 * it is the same number the AI drivers are rated on". A management decision the
 * player cannot price is not a decision, and this game's whole claim is that its
 * numbers are the numbers the car uses. Where a slot's effect depends on the
 * career being My Team, the option says so rather than being quietly inert.
 */

export interface PreparationOptions {
  career: Career;
  /** Called after a slot is spent, so the caller can save and repaint. */
  onChange: () => void;
}

const TRAINABLE: { key: 'skill' | 'consistency' | 'tyreManagement' | 'wetSkill' | 'racecraft'; name: string; why: string }[] = [
  { key: 'skill', name: 'Raw pace', why: 'The single biggest term in a lap time, for you and for every AI driver.' },
  { key: 'consistency', name: 'Consistency', why: 'Fewer mistakes. Pressure is subtracted from it, so it is also your buffer.' },
  { key: 'tyreManagement', name: 'Tyre management', why: 'Longer stints, which is what makes a one-stop possible.' },
  { key: 'wetSkill', name: 'Wet weather', why: 'Used in place of most of your pace when it rains.' },
  { key: 'racecraft', name: 'Racecraft', why: 'Overtaking, defending, and the first lap.' },
];

export function buildPreparation(
  root: HTMLElement, opts: PreparationOptions,
): { refresh(): void } {
  const { career } = opts;

  const host = document.createElement('div');
  root.appendChild(host);

  const paint = (): void => {
    host.innerHTML = '';
    const left = career.state.prepSlotsLeft;

    if (left <= 0) {
      el('div', 'decisions-clear', host,
        'No preparation left before the next round. More arrive after the race — '
        + 'two normally, three when the calendar leaves a longer gap.');
      return;
    }

    const list = el('div', 'decisions', host);

    // --- Training ----------------------------------------------------------
    //
    // The one slot with a target, so it is presented as five decisions rather
    // than one: which attribute is the whole of the choice.
    for (const t of TRAINABLE) {
      const now = career.state.player[t.key];
      row(list, {
        label: 'Train — ' + t.name,
        why: t.why + ` Currently ${(now * 100).toFixed(0)}. A week is worth about `
          + `+${((0.004 + (1 - now) * 0.012) * 100).toFixed(1)}, permanently; the closer `
          + 'to the ceiling you are, the less it buys.',
        urgency: 'idle',
        action: 'Train',
        onClick: () => { career.spendPrepSlot('train', t.key); opts.onChange(); },
      });
    }

    // --- The rest ----------------------------------------------------------
    row(list, {
      label: 'Simulator',
      why: 'The next weekend starts from a tuned set-up for that circuit instead of '
        + 'the generic baseline.',
      urgency: 'idle',
      action: 'Book it',
      onClick: () => { career.spendPrepSlot('simulator'); opts.onChange(); },
    });

    const morale = moraleLine(career);
    row(list, {
      label: 'Media day',
      why: '+4 fan rating, and every department loses 2 morale because you were not '
        + 'at the factory. '
        + (career.myTeam
          ? 'Fan rating is your commercial income, so this is money — and morale is '
            + 'what the next upgrade costs. ' + morale
          : 'Fan rating decides which sponsors will talk to you.'),
      urgency: 'idle',
      action: 'Do the round',
      onClick: () => { career.spendPrepSlot('media'); opts.onChange(); },
    });

    row(list, {
      label: 'Factory visit',
      why: '+5 morale in every department. '
        + (career.myTeam
          ? 'A proud department charges less for a project and fails quality control '
            + 'less often — at 100 morale a part is three quarters of list price. ' + morale
          : 'Only meaningful once you run your own team.'),
      urgency: 'idle',
      action: 'Go in',
      onClick: () => { career.spendPrepSlot('factory'); opts.onChange(); },
    });

    row(list, {
      label: 'Sponsor day',
      why: career.myTeam
        ? '+$0.75M, straight into the bank and outside the cost cap.'
        : 'Only meaningful once you run your own team — there is no bank to pay into.',
      urgency: 'idle',
      action: 'Take the money',
      onClick: () => { career.spendPrepSlot('sponsor'); opts.onChange(); },
    });
  };

  paint();
  return { refresh: paint };
}

/** Where the factory's morale actually is, so the two options above are priced. */
function moraleLine(career: Career): string {
  const t = career.myTeam;
  if (!t) return '';
  return 'Now: ' + DEPARTMENT_IDS
    .map((d) => DEPARTMENT_NAME[d] + ' ' + Math.round(t.departments[d].morale))
    .join(', ') + '.';
}

interface RowSpec {
  label: string;
  why: string;
  urgency: 'now' | 'soon' | 'idle';
  action: string;
  onClick: () => void;
}

function row(parent: HTMLElement, spec: RowSpec): void {
  const r = el('div', 'decision ' + spec.urgency, parent);
  const text = el('div', 'decision-text', r);
  el('div', 'decision-label', text, spec.label);
  el('div', 'decision-why', text, spec.why);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'decision-go';
  b.textContent = spec.action;
  b.addEventListener('click', spec.onClick);
  r.appendChild(b);
}

function el(tag: string, cls: string, parent: HTMLElement, text = ''): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}
