declare namespace Temporal {
  export class Instant {
    static from(item: string | Instant): Instant;
    static fromEpochMilliseconds(epochMilliseconds: number): Instant;
    static fromEpochNanoseconds(epochNanoseconds: bigint): Instant;
    static compare(one: Instant | string, two: Instant | string): number;
    readonly epochMilliseconds: number;
    readonly epochNanoseconds: bigint;
    add(duration: Duration | string | object): Instant;
    subtract(duration: Duration | string | object): Instant;
    until(other: Instant | string, options?: object): Duration;
    since(other: Instant | string, options?: object): Duration;
    round(options: string | object): Instant;
    equals(other: Instant | string): boolean;
    toString(options?: object): string;
    toJSON(): string;
    toLocaleString(locales?: string | string[], options?: object): string;
    toZonedDateTimeISO(timeZone: string | object): ZonedDateTime;
  }

  export class ZonedDateTime {
    static from(item: string | ZonedDateTime | object, options?: object): ZonedDateTime;
    static compare(one: ZonedDateTime | string | object, two: ZonedDateTime | string | object): number;
    readonly year: number;
    readonly month: number;
    readonly monthCode: string;
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
    readonly second: number;
    readonly millisecond: number;
    readonly microsecond: number;
    readonly nanosecond: number;
    readonly timeZoneId: string;
    readonly calendarId: string;
    readonly epochMilliseconds: number;
    readonly epochNanoseconds: bigint;
    readonly offsetNanoseconds: number;
    readonly offset: string;
    readonly hoursInDay: number;
    readonly dayOfWeek: number;
    readonly dayOfYear: number;
    readonly weekOfYear: number | undefined;
    readonly yearOfWeek: number | undefined;
    readonly daysInWeek: number;
    readonly daysInMonth: number;
    readonly daysInYear: number;
    readonly monthsInYear: number;
    readonly inLeapYear: boolean;
    with(compoundSlot: object, options?: object): ZonedDateTime;
    withPlainTime(plainTime?: PlainTime | string | object): ZonedDateTime;
    withPlainDate(plainDate: PlainDate | string | object): ZonedDateTime;
    withTimeZone(timeZone: string | object): ZonedDateTime;
    withCalendar(calendar: string | object): ZonedDateTime;
    add(duration: Duration | string | object, options?: object): ZonedDateTime;
    subtract(duration: Duration | string | object, options?: object): ZonedDateTime;
    until(other: ZonedDateTime | string | object, options?: object): Duration;
    since(other: ZonedDateTime | string | object, options?: object): Duration;
    round(options: string | object): ZonedDateTime;
    equals(other: ZonedDateTime | string | object): boolean;
    startOfDay(): ZonedDateTime;
    toInstant(): Instant;
    toPlainDateTime(): PlainDateTime;
    toPlainDate(): PlainDate;
    toPlainTime(): PlainTime;
    toPlainYearMonth(): PlainYearMonth;
    toPlainMonthDay(): PlainMonthDay;
    getISOFields(): object;
    toString(options?: object): string;
    toJSON(): string;
    toLocaleString(locales?: string | string[], options?: object): string;
  }

  export class PlainDate {
    static from(item: string | PlainDate | object, options?: object): PlainDate;
    static compare(one: PlainDate | string | object, two: PlainDate | string | object): number;
    constructor(isoYear: number, isoMonth: number, isoDay: number, calendar?: string | object);
    readonly year: number;
    readonly month: number;
    readonly monthCode: string;
    readonly day: number;
    readonly calendarId: string;
    readonly dayOfWeek: number;
    readonly dayOfYear: number;
    readonly weekOfYear: number | undefined;
    readonly yearOfWeek: number | undefined;
    readonly daysInWeek: number;
    readonly daysInMonth: number;
    readonly daysInYear: number;
    readonly monthsInYear: number;
    readonly inLeapYear: boolean;
    with(compoundSlot: object, options?: object): PlainDate;
    withCalendar(calendar: string | object): PlainDate;
    add(duration: Duration | string | object, options?: object): PlainDate;
    subtract(duration: Duration | string | object, options?: object): PlainDate;
    until(other: PlainDate | string | object, options?: object): Duration;
    since(other: PlainDate | string | object, options?: object): Duration;
    round(options: string | object): PlainDate;
    equals(other: PlainDate | string | object): boolean;
    toPlainDateTime(temporalTime?: PlainTime | string | object): PlainDateTime;
    toZonedDateTime(item: string | object): ZonedDateTime;
    toPlainYearMonth(): PlainYearMonth;
    toPlainMonthDay(): PlainMonthDay;
    getISOFields(): object;
    toString(options?: object): string;
    toJSON(): string;
    toLocaleString(locales?: string | string[], options?: object): string;
  }

  export class PlainTime {
    static from(item: string | PlainTime | object, options?: object): PlainTime;
    static compare(one: PlainTime | string | object, two: PlainTime | string | object): number;
    constructor(hour?: number, minute?: number, second?: number, millisecond?: number, microsecond?: number, nanosecond?: number);
    readonly hour: number;
    readonly minute: number;
    readonly second: number;
    readonly millisecond: number;
    readonly microsecond: number;
    readonly nanosecond: number;
    with(compoundSlot: object, options?: object): PlainTime;
    add(duration: Duration | string | object, options?: object): PlainTime;
    subtract(duration: Duration | string | object, options?: object): PlainTime;
    until(other: PlainTime | string | object, options?: object): Duration;
    since(other: PlainTime | string | object, options?: object): Duration;
    round(options: string | object): PlainTime;
    equals(other: PlainTime | string | object): boolean;
    toPlainDateTime(temporalDate: PlainDate | string | object): PlainDateTime;
    toZonedDateTime(item: object): ZonedDateTime;
    getISOFields(): object;
    toString(options?: object): string;
    toJSON(): string;
    toLocaleString(locales?: string | string[], options?: object): string;
  }

  export class PlainDateTime {
    static from(item: string | PlainDateTime | object, options?: object): PlainDateTime;
    static compare(one: PlainDateTime | string | object, two: PlainDateTime | string | object): number;
    constructor(isoYear: number, isoMonth: number, isoDay: number, hour?: number, minute?: number, second?: number, millisecond?: number, microsecond?: number, nanosecond?: number, calendar?: string | object);
    readonly year: number;
    readonly month: number;
    readonly monthCode: string;
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
    readonly second: number;
    readonly millisecond: number;
    readonly microsecond: number;
    readonly nanosecond: number;
    readonly calendarId: string;
    readonly dayOfWeek: number;
    readonly dayOfYear: number;
    readonly weekOfYear: number | undefined;
    readonly yearOfWeek: number | undefined;
    readonly daysInWeek: number;
    readonly daysInMonth: number;
    readonly daysInYear: number;
    readonly monthsInYear: number;
    readonly inLeapYear: boolean;
    with(compoundSlot: object, options?: object): PlainDateTime;
    withPlainTime(plainTime?: PlainTime | string | object): PlainDateTime;
    withPlainDate(plainDate: PlainDate | string | object): PlainDateTime;
    withCalendar(calendar: string | object): PlainDateTime;
    add(duration: Duration | string | object, options?: object): PlainDateTime;
    subtract(duration: Duration | string | object, options?: object): PlainDateTime;
    until(other: PlainDateTime | string | object, options?: object): Duration;
    since(other: PlainDateTime | string | object, options?: object): Duration;
    round(options: string | object): PlainDateTime;
    equals(other: PlainDateTime | string | object): boolean;
    toZonedDateTime(timeZone: string | object, options?: object): ZonedDateTime;
    toPlainDate(): PlainDate;
    toPlainTime(): PlainTime;
    toPlainYearMonth(): PlainYearMonth;
    toPlainMonthDay(): PlainMonthDay;
    getISOFields(): object;
    toString(options?: object): string;
    toJSON(): string;
    toLocaleString(locales?: string | string[], options?: object): string;
  }

  export class Duration {
    static from(item: string | Duration | object): Duration;
    static compare(one: Duration | string | object, two: Duration | string | object, options?: object): number;
    constructor(years?: number, months?: number, weeks?: number, days?: number, hours?: number, minutes?: number, seconds?: number, milliseconds?: number, microseconds?: number, nanoseconds?: number);
    readonly years: number;
    readonly months: number;
    readonly weeks: number;
    readonly days: number;
    readonly hours: number;
    readonly minutes: number;
    readonly seconds: number;
    readonly milliseconds: number;
    readonly microseconds: number;
    readonly nanoseconds: number;
    readonly sign: number;
    readonly blank: boolean;
    with(durationLike: object): Duration;
    negated(): Duration;
    abs(): Duration;
    add(other: Duration | string | object, options?: object): Duration;
    subtract(other: Duration | string | object, options?: object): Duration;
    round(options: string | object): Duration;
    total(options: string | object): number;
    toString(options?: object): string;
    toJSON(): string;
    toLocaleString(locales?: string | string[], options?: object): string;
  }

  export class PlainYearMonth {
    static from(item: string | PlainYearMonth | object, options?: object): PlainYearMonth;
    static compare(one: PlainYearMonth | string | object, two: PlainYearMonth | string | object): number;
    constructor(isoYear: number, isoMonth: number, calendar?: string | object, referenceISODay?: number);
    readonly year: number;
    readonly month: number;
    readonly monthCode: string;
    readonly calendarId: string;
    readonly daysInMonth: number;
    readonly daysInYear: number;
    readonly monthsInYear: number;
    readonly inLeapYear: boolean;
    with(compoundSlot: object, options?: object): PlainYearMonth;
    add(duration: Duration | string | object, options?: object): PlainYearMonth;
    subtract(duration: Duration | string | object, options?: object): PlainYearMonth;
    until(other: PlainYearMonth | string | object, options?: object): Duration;
    since(other: PlainYearMonth | string | object, options?: object): Duration;
    equals(other: PlainYearMonth | string | object): boolean;
    toPlainDate(item: object): PlainDate;
    getISOFields(): object;
    toString(options?: object): string;
    toJSON(): string;
    toLocaleString(locales?: string | string[], options?: object): string;
  }

  export class PlainMonthDay {
    static from(item: string | PlainMonthDay | object, options?: object): PlainMonthDay;
    constructor(isoMonth: number, isoDay: number, calendar?: string | object, referenceISOYear?: number);
    readonly monthCode: string;
    readonly calendarId: string;
    with(compoundSlot: object, options?: object): PlainMonthDay;
    equals(other: PlainMonthDay | string | object): boolean;
    toPlainDate(item: object): PlainDate;
    getISOFields(): object;
    toString(options?: object): string;
    toJSON(): string;
    toLocaleString(locales?: string | string[], options?: object): string;
  }

  export namespace Now {
    export function instant(): Instant;
    export function zonedDateTimeISO(timeZone?: string | object): ZonedDateTime;
    export function plainDateTimeISO(timeZone?: string | object): PlainDateTime;
    export function plainDateISO(timeZone?: string | object): PlainDate;
    export function plainTimeISO(timeZone?: string | object): PlainTime;
    export function timeZoneId(): string;
  }
}



interface Date {
  toTemporalInstant(): Temporal.Instant;
}
