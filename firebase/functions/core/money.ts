// money.ts
// Money is stored as a whole number of the smallest unit (cents), never as a
// decimal. 0.1 + 0.2 !== 0.3 in floating point, and money bugs must be impossible.

export class InvalidMoney extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoney';
  }
}

export class Money {
  // Private constructor: the ONLY way to make Money is Money.kes(), which validates.
  private constructor(readonly minorUnits: number) {}

  static kes(minorUnits: number): Money {
    // isSafeInteger rejects fractions, NaN, Infinity and numbers too big to be exact.
    if (!Number.isSafeInteger(minorUnits)) {
      throw new InvalidMoney(`Money must be a whole number of minor units, got ${minorUnits}`);
    }
    if (minorUnits < 0) {
      throw new InvalidMoney(`Money cannot be negative, got ${minorUnits}`);
    }
    return new Money(minorUnits);
  }

  add(other: Money): Money {
    return Money.kes(this.minorUnits + other.minorUnits); // re-validates (catches overflow)
  }

  subtract(other: Money): Money {
    return Money.kes(this.minorUnits - other.minorUnits); // throws if result < 0
  }

  equals(other: Money): boolean {
    return this.minorUnits === other.minorUnits;
  }

  isZero(): boolean {
    return this.minorUnits === 0; // a free RSVP never calls pay()
  }
}
