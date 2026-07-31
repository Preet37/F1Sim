/**
 * The pause menu.
 *
 * `P` and `Escape` already stopped the simulation clock before this existed, and
 * that was the whole problem: the picture froze, the engine note cut, and
 * nothing on screen said why or offered a way out. A pause with no menu is
 * indistinguishable from a crash, and on a phone — where there is no Escape key
 * — it was also unreachable and unescapable.
 *
 * Four things belong here and nothing else does. Resume, because that is what
 * pause is for. Restart, because the single most common reason to reach for the
 * pause button mid-session is that the last thirty seconds went badly. Settings,
 * because assists and difficulty are exactly what a player wants to change when
 * a session is going wrong, and making them go back to the main menu to do it
 * means abandoning the session. And quit, stated plainly as abandoning the
 * session, because it is destructive and should not be a surprise.
 *
 * The overlay is a sibling of the HUD rather than one of the app's screens: the
 * canvas keeps its last frame behind it. A paused race that shows you the corner
 * you are stopped in is a pause; one that cuts to a black menu page is a
 * different screen, and coming back from it feels like a reload.
 */

export interface PauseMenuInfo {
  sessionName: string;
  circuitName: string;
  /** A line of state — position, lap, flag — shown under the title. */
  status: string;
  /** Set when quitting will lose an unrecorded result. */
  quitWarning?: string;
}

export interface PauseMenuActions {
  onResume: () => void;
  onRestart: () => void;
  onSettings: () => void;
  onQuit: () => void;
}

export class PauseMenu {
  readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly status: HTMLElement;
  private readonly buttons: HTMLElement;
  private shown = false;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'pause-overlay hidden';

    const card = document.createElement('div');
    card.className = 'pause-card';
    this.root.appendChild(card);

    this.title = document.createElement('div');
    this.title.className = 'pause-title';
    this.title.textContent = 'PAUSED';
    card.appendChild(this.title);

    this.subtitle = document.createElement('div');
    this.subtitle.className = 'pause-subtitle';
    card.appendChild(this.subtitle);

    this.status = document.createElement('div');
    this.status.className = 'pause-status';
    card.appendChild(this.status);

    this.buttons = document.createElement('div');
    this.buttons.className = 'pause-buttons';
    card.appendChild(this.buttons);

    parent.appendChild(this.root);
  }

  get visible(): boolean {
    return this.shown;
  }

  show(info: PauseMenuInfo, actions: PauseMenuActions): void {
    this.subtitle.textContent = info.sessionName + ' · ' + info.circuitName;
    this.status.textContent = info.status;
    this.buttons.textContent = '';

    const add = (label: string, meta: string, onClick: () => void, cls = 'btn') => {
      const b = document.createElement('button');
      b.className = cls;
      b.innerHTML = '<span class="pause-btn-label"></span><span class="pause-btn-meta"></span>';
      (b.firstChild as HTMLElement).textContent = label;
      (b.lastChild as HTMLElement).textContent = meta;
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
      this.buttons.appendChild(b);
      return b;
    };

    add('Resume', 'Back to the car', actions.onResume);
    add('Restart Session', 'Same circuit, same session, from the start',
      actions.onRestart, 'btn secondary');
    add('Settings', 'Assists, difficulty, camera and audio',
      actions.onSettings, 'btn secondary');
    add('Quit to Menu', info.quitWarning ?? 'Abandon this session',
      actions.onQuit, 'btn secondary danger');

    this.root.classList.remove('hidden');
    this.shown = true;
  }

  hide(): void {
    this.root.classList.add('hidden');
    this.shown = false;
  }
}
