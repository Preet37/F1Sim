/**
 * White noise, shared by every layer that needs it.
 *
 * One buffer, generated once and looped, is the cheapest noise source WebAudio
 * offers: an `AudioBufferSourceNode` reading a looped buffer costs a memory
 * read per sample, where a `ScriptProcessor` or an `AudioWorklet` filling noise
 * on demand costs a callback into JavaScript. At sixty frames a second with a
 * race going on, that difference is the whole budget.
 *
 * Two seconds is long enough that the loop point is inaudible under a filter.
 * Anything shorter develops a periodicity the ear picks up as a faint tone.
 */
export function noiseBuffer(ctx: BaseAudioContext, seconds = 2): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}
