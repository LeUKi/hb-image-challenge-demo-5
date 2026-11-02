/** A late response may only update the participant who started the operation. */
export class ParticipantScope {
  private key = ''
  private generation = 0

  enter(key: string): boolean {
    if (!key || key === this.key) return false
    this.key = key
    this.generation += 1
    return true
  }

  ticket(): number { return this.generation }
  isCurrent(ticket: number): boolean { return ticket === this.generation }
  assertCurrent(ticket: number): void { if (!this.isCurrent(ticket)) throw new Error('参与身份已变化，本次回应不再显示') }
}
