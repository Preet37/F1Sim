import './frontend.css';
import { button, el, optBlock, optChoice, optSlider, optSwitch } from './frontendKit';

/**
 * SETTINGS.
 *
 * ---------------------------------------------------------------------------
 * WHY A RAIL OF TABS
 * ---------------------------------------------------------------------------
 *
 * The screen this replaces was seven headings stacked down one scrolling page,
 * and the fault in that is not that it was ugly. It was that the SHAPE of the
 * settings was invisible: you could not tell from looking whether there were
 * three subjects or thirty, so the only way to find out whether the game let
 * you change the render quality was to scroll the whole page and fail to find
 * it — which is what happened, because there was no control for it at all.
 * The weekend length had no home either; it was reachable only from inside the
 * session-select screen, so nobody knew the game had it.
 *
 * Eight tabs make eight subjects. Every setting the game holds is under
 * exactly one of them, and there is now nothing in `GameSettings` that has no
 * screen.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY CHANGE SAVES IMMEDIATELY
 * ---------------------------------------------------------------------------
 *
 * There is no Apply and no Cancel. A settings screen with an apply step is a
 * settings screen you can leave without your change having happened, and the
 * one thing worse than a setting that does not work is a setting that worked
 * and then silently did not. The single button on the page goes back.
 *
 * The screen repaints itself after every change, EXCEPT while a slider is
 * being dragged — repainting mid-drag destroys the element under the thumb,
 * which is the specific bug the old screen had with its lap-count field.
 */

export type SettingsTabId =
  | 'opposition' | 'driving' | 'controls' | 'camera'
  | 'audio' | 'video' | 'weekend' | 'device';

export interface SettingsTab {
  id: SettingsTabId;
  /** As it reads on the rail. Short: eight of these have to fit on a phone. */
  label: string;
  /** The heading inside the panel. */
  title: string;
  /** One sentence saying what this tab is for. */
  note: string;
  /** Fills the panel. Called on every repaint. */
  build: (panel: HTMLElement, kit: SettingsKit) => void;
}

/** The controls a tab may use. Passed in so a tab body imports nothing. */
export interface SettingsKit {
  toggle: typeof optSwitch;
  choice: typeof optChoice;
  slider: typeof optSlider;
  block: typeof optBlock;
  el: typeof el;
  button: typeof button;
}

const KIT: SettingsKit = {
  toggle: optSwitch, choice: optChoice, slider: optSlider,
  block: optBlock, el, button,
};

export interface SettingsScreenSpec {
  tabs: SettingsTab[];
  /** Which tab is open. Held by the caller so it survives a repaint. */
  active: SettingsTabId;
  onTab: (id: SettingsTabId) => void;
}

export function buildSettingsScreen(root: HTMLElement, spec: SettingsScreenSpec): void {
  root.classList.add('set');

  const rail = el('div', 'set-rail', root);
  rail.setAttribute('role', 'tablist');
  for (const t of spec.tabs) {
    const on = t.id === spec.active;
    const b = button('set-tab' + (on ? ' on' : ''), rail, () => spec.onTab(t.id));
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    el('span', '', b, t.label);
  }

  const panel = el('div', 'set-panel', root);
  panel.setAttribute('role', 'tabpanel');
  const tab = spec.tabs.find((t) => t.id === spec.active) ?? spec.tabs[0];
  el('div', 'set-panel-head', panel, tab.title);
  el('div', 'set-panel-note', panel, tab.note);
  tab.build(panel, KIT);
}
