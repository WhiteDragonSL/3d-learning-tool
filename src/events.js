// Tiny event bus. Every user action is announced here so the UI and
// the tutorial engine can react to it.
class Emitter {
  constructor() { this.listeners = {}; }

  on(type, fn) {
    (this.listeners[type] ||= []).push(fn);
    return () => { this.listeners[type] = this.listeners[type].filter((f) => f !== fn); };
  }

  emit(type, data = {}) {
    for (const fn of this.listeners[type] || []) fn(data);
    for (const fn of this.listeners['*'] || []) fn(type, data);
  }
}

export const bus = new Emitter();
