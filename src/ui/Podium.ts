import './career.css';
import { driverPortraitSvg } from './DriverPortrait';
import { hex, helmetForDriver, type HelmetDesign } from '../career/Identity';

/**
 * The podium.
 *
 * The payoff. A ladder that starts in Formula 3 and ends in a world
 * championship is worth nothing if arriving anywhere on it produces the same
 * table of twenty rows the last race produced — the whole point of the climb is
 * that some results are different in kind, and nothing in this game said so.
 *
 * THE DESIGN IS THE OBJECT. A podium is three steps at three heights, with the
 * winner in the middle and second on their right, and its entire purpose is to
 * be legible from the back of a grandstand. So this is not three cards in a
 * row: the blocks are genuinely different heights, the order is 2–1–3, and the
 * winner's type is a size larger. Everything else on the screen stays quiet.
 *
 * It shares the driver portrait with every other career screen, so the person
 * standing on the top step is drawn by the same code as the person on the
 * create screen — which is what makes reaching it feel like the same career
 * rather than a different screen about a stranger.
 *
 * AI drivers get a helmet derived from their id (`helmetForDriver`), which
 * means every driver on the grid has one, it is the same one every time, and
 * not a byte of it is stored.
 */

export interface PodiumEntry {
  driverId: string;
  firstName: string;
  lastName: string;
  teamName: string;
  colour: number;
  accent: number;
  /** "+4.281", "+1 LAP", or empty for the winner. */
  gap: string;
  isPlayer: boolean;
  /** The player's designed helmet. Omitted for the AI, which derives one. */
  helmet?: HelmetDesign;
}

export interface PodiumSpec {
  /** In finishing order. Fewer than three is legal; a step is simply absent. */
  top3: readonly PodiumEntry[];
  /** Where the player actually finished, 1-based. 0 when they did not finish. */
  playerPosition: number;
  circuitName: string;
  tierName: string;
}

/** Renders the podium into a container. Returns it. */
export function buildPodium(parent: HTMLElement, spec: PodiumSpec): HTMLElement {
  const wrap = document.createElement('div');
  parent.appendChild(wrap);

  const verdict = document.createElement('div');
  const v = verdictFor(spec);
  verdict.className = 'pod-verdict ' + v.cls;
  verdict.textContent = v.title;
  wrap.appendChild(verdict);

  const line = document.createElement('div');
  line.className = 'pod-line';
  line.textContent = v.line;
  wrap.appendChild(line);

  const pod = document.createElement('div');
  pod.className = 'podium';
  wrap.appendChild(pod);

  // Second, first, third — the arrangement of the real object.
  for (const [slot, pos] of [1, 0, 2].entries()) {
    const e = spec.top3[pos];
    const step = document.createElement('div');
    step.className = 'pod-step p' + (pos + 1) + (e?.isPlayer ? ' me' : '');
    step.style.setProperty('--team', hex(e?.colour ?? 0x2b3440));
    pod.appendChild(step);
    void slot;

    if (!e) {
      // A step with nobody on it still has to hold its column, or the podium
      // would re-centre itself when a race classified fewer than three cars.
      const block = document.createElement('div');
      block.className = 'pod-block';
      step.appendChild(block);
      continue;
    }

    const helmet = e.helmet ?? helmetForDriver(e.driverId);
    step.style.setProperty('--me', hex(helmet.base));

    const art = document.createElement('div');
    art.className = 'pod-art';
    art.appendChild(driverPortraitSvg(helmet, {
      suit: e.colour, accent: e.accent, uid: 'pod-' + pos,
    }));
    step.appendChild(art);

    const block = document.createElement('div');
    block.className = 'pod-block';
    step.appendChild(block);

    add(block, 'pod-pos', String(pos + 1));
    add(block, 'pod-name', e.lastName.toUpperCase());
    add(block, 'pod-team', e.teamName);
    if (e.gap) add(block, 'pod-gap', e.gap);
  }

  return wrap;
}

/**
 * What this result was.
 *
 * Written from the player's position rather than from the winner's, because
 * this screen is about the career it belongs to. A win, a podium, a points
 * finish and a race that went wrong are four different sentences, and a screen
 * that said "Race complete" for all four would be the screen this replaces.
 */
function verdictFor(spec: PodiumSpec): { title: string; line: string; cls: string } {
  const p = spec.playerPosition;
  const winner = spec.top3[0];
  const winnerName = winner ? winner.firstName + ' ' + winner.lastName : 'Nobody';

  if (p === 1) {
    return {
      title: 'You won at ' + spec.circuitName,
      line: 'Top step. The anthem is yours and so are twenty-five points.',
      cls: 'win',
    };
  }
  if (p === 2 || p === 3) {
    return {
      title: 'P' + p + ' at ' + spec.circuitName,
      line: 'On the podium. ' + winnerName + ' took the win.',
      cls: 'podium',
    };
  }
  if (p > 0 && p <= 10) {
    return {
      title: 'P' + p + ' at ' + spec.circuitName,
      line: 'Points, and a step closer. ' + winnerName + ' won it.',
      cls: '',
    };
  }
  if (p > 0) {
    return {
      title: 'P' + p + ' at ' + spec.circuitName,
      line: 'Nothing scored. ' + winnerName + ' won it, and the ' + spec.tierName
        + ' championship does not wait.',
      cls: '',
    };
  }
  return {
    title: 'Out at ' + spec.circuitName,
    line: 'No classification. ' + winnerName + ' won it.',
    cls: '',
  };
}

function add(parent: HTMLElement, cls: string, text: string): HTMLElement {
  const e = document.createElement('div');
  e.className = cls;
  e.textContent = text;
  parent.appendChild(e);
  return e;
}
