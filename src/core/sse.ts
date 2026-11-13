export interface SseEvent {
  event?: string;
  id?: string;
  data: string;
}

/**
 * Incremental Server-Sent Events parser. Feed decoded text chunks; blank lines
 * dispatch the accumulated event. Handles multi-line `data:` fields, comments,
 * CRLF, and a final unterminated event.
 */
export class SseParser {
  private buffer = "";
  private dataLines: string[] = [];
  private eventName: string | undefined;
  private id: string | undefined;

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.processLine(line, events);
      newline = this.buffer.indexOf("\n");
    }
    return events;
  }

  end(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer.length > 0) {
      let line = this.buffer;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.processLine(line, events);
      this.buffer = "";
    }
    this.dispatch(events);
    return events;
  }

  private processLine(line: string, events: SseEvent[]): void {
    if (line === "") {
      this.dispatch(events);
      return;
    }
    if (line.startsWith(":")) return;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "data":
        this.dataLines.push(value);
        break;
      case "event":
        this.eventName = value;
        break;
      case "id":
        this.id = value;
        break;
      default:
        break;
    }
  }

  private dispatch(events: SseEvent[]): void {
    if (this.dataLines.length === 0) {
      this.eventName = undefined;
      this.id = undefined;
      return;
    }
    events.push({
      data: this.dataLines.join("\n"),
      ...(this.eventName !== undefined ? { event: this.eventName } : {}),
      ...(this.id !== undefined ? { id: this.id } : {}),
    });
    this.dataLines = [];
    this.eventName = undefined;
    this.id = undefined;
  }
}
