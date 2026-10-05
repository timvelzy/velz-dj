/**
 * Type declarations for the AudioWorklet global scope.
 *
 * TypeScript ships no types for AudioWorkletGlobalScope (neither the DOM nor
 * the WebWorker lib covers it), so we declare the small surface this project
 * actually uses. This file must NOT be imported — it's ambient.
 */

declare var sampleRate: number;
declare var currentTime: number;
declare var currentFrame: number;

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor
): void;

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}
