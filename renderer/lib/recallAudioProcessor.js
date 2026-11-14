/* global AudioWorkletProcessor, registerProcessor, sampleRate */
// A separate Recall-only graph. Outputs remain silent; microphone is never monitored.
class RecallPcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.frames = 0; }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input && this.frames < sampleRate * 25) {
      const copy = input.slice(0, Math.min(input.length, sampleRate * 25 - this.frames));
      this.frames += copy.length;
      this.port.postMessage(copy, [copy.buffer]);
    }
    return this.frames < sampleRate * 25;
  }
}
registerProcessor('recall-pcm-capture', RecallPcmCapture);
