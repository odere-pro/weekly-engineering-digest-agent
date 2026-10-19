/**
 * How a decorator rebuilds each member of a port: one rule per member, optional ones too (`-?`).
 * A decorator is built from its table, so a member added to the port is a type error until the table
 * says how it is wrapped (traced, redacted, retried, or passed through), and a member that leaves
 * the port is one too. Writing `{ ... }` by hand and returning it as the port does not catch an
 * optional member, and says nothing about a member the decorator forgot to wrap on purpose.
 */
export type MemberRules<Port, Context> = {
  readonly [Member in keyof Port]-?: (inner: Port, context: Context) => Port[Member];
};

/**
 * A new port that has exactly the members of `rules`, each built by its rule from the wrapped port
 * and the context. A member of `inner` without a rule is never copied over: nothing reaches the
 * channel, the store or the model unwrapped by accident. `inner` itself is not changed.
 *
 * Declare the table as `MemberRules<Port, Context>` (that is what fixes `Port`) and call
 * `inner.method(...)` inside a rule, never pass `inner.method` on unbound. A rule of an optional
 * member that returns `undefined` leaves the member out.
 */
export function decorate<Port extends object, Context>(
  inner: NoInfer<Port>,
  context: Context,
  rules: MemberRules<Port, Context>,
): Port {
  const members = (Object.keys(rules) as (keyof Port)[])
    .map((member) => [member, rules[member](inner, context)] as const)
    .filter(([, built]) => built !== undefined);
  // Safe: `MemberRules` has a rule for every member of `Port`, so every member is built.
  return Object.fromEntries(members) as Port;
}
