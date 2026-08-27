export class DurableObject<Env = unknown> {
  constructor(public state: unknown, public env: Env) {}
}
