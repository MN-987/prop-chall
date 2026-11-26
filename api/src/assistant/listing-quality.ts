/**
 * Data-quality checks for listings. Agents type listings in by hand, so a listing can carry a typo'd price, be a
 * second copy of another listing, or miss its rent figure. These checks are plain code: the model sees their result,
 * but never decides them.
 */

/** The listing fields the checks need (a subset of the property DTO). */
export interface ListingFacts {
  id: string;
  reference: string;
  area: string;
  building: string | null;
  type: string;
  bedrooms: number;
  sizeSqft: number;
  priceAed: number;
  annualRentAed: number | null;
  listedAt: string;
}

export type ListingWarningCode = 'price_implausible' | 'duplicate_listing' | 'rent_missing' | 'yield_implausible';

export interface ListingWarning {
  code: ListingWarningCode;
  message: string;
}

/**
 * Asking prices per square foot outside this band are not real Dubai prices (the recorded sales run from about
 * 900 to 3,000 AED per sqft). Below it is almost always a missing-zeros typo, like 21,500 for 2,150,000.
 */
export const MIN_PLAUSIBLE_AED_PER_SQFT = 300;
export const MAX_PLAUSIBLE_AED_PER_SQFT = 15_000;

/** A gross yield above this is a data error (Dubai gross yields sit around 4 to 9%). */
export const MAX_PLAUSIBLE_GROSS_YIELD = 0.2;

/** Warnings that make a listing impossible to recommend. `rent_missing` is not one: the listing is real, its yield is unknown. */
const BLOCKING: ReadonlySet<ListingWarningCode> = new Set(['price_implausible', 'duplicate_listing', 'yield_implausible']);

export function priceAedPerSqft(listing: Pick<ListingFacts, 'priceAed' | 'sizeSqft'>): number | null {
  if (listing.sizeSqft <= 0) return null;
  return listing.priceAed / listing.sizeSqft;
}

/** Gross yield = annualRentAed / priceAed. Null when the rent is unknown or the price is not usable. */
export function grossYield(listing: Pick<ListingFacts, 'priceAed' | 'sizeSqft' | 'annualRentAed'>): number | null {
  if (listing.annualRentAed == null || listing.priceAed <= 0) return null;
  if (isPriceImplausible(listing)) return null;
  return listing.annualRentAed / listing.priceAed;
}

function isPriceImplausible(listing: Pick<ListingFacts, 'priceAed' | 'sizeSqft'>): boolean {
  const perSqft = priceAedPerSqft(listing);
  return perSqft === null || perSqft < MIN_PLAUSIBLE_AED_PER_SQFT || perSqft > MAX_PLAUSIBLE_AED_PER_SQFT;
}

/** Two listings are the same unit when every hard fact matches. The one listed first is the original. */
function duplicateKey(listing: ListingFacts): string {
  return [
    listing.area.trim().toLowerCase(),
    (listing.building ?? '').trim().toLowerCase(),
    listing.type,
    listing.bedrooms,
    listing.sizeSqft,
    listing.priceAed,
  ].join('|');
}

function isListedBefore(a: ListingFacts, b: ListingFacts): boolean {
  if (a.listedAt !== b.listedAt) return a.listedAt < b.listedAt;
  return a.reference < b.reference;
}

/**
 * The original of `listing` among `others`, if `listing` is a later copy of it. `others` should hold the agency's
 * listings that could match (same building, size and price); `listing` itself may be among them.
 */
export function findOriginal(listing: ListingFacts, others: ListingFacts[]): ListingFacts | null {
  const key = duplicateKey(listing);
  let original: ListingFacts | null = null;
  for (const other of others) {
    if (other.id === listing.id || duplicateKey(other) !== key) continue;
    if (!isListedBefore(other, listing)) continue;
    if (!original || isListedBefore(other, original)) original = other;
  }
  return original;
}

export function listingWarnings(listing: ListingFacts, others: ListingFacts[]): ListingWarning[] {
  const warnings: ListingWarning[] = [];
  const perSqft = priceAedPerSqft(listing);
  if (isPriceImplausible(listing)) {
    warnings.push({
      code: 'price_implausible',
      message: `Asking price of AED ${listing.priceAed.toLocaleString('en-US')} is ${
        perSqft === null ? 'unusable' : `AED ${Math.round(perSqft)} per sqft`
      }, which is not a real price: probably a typo. Do not recommend until the price is fixed.`,
    });
  }
  const original = findOriginal(listing, others);
  if (original) {
    warnings.push({
      code: 'duplicate_listing',
      message: `Same unit as ${original.reference} (same building, size and price), listed later. Recommend ${original.reference} instead.`,
    });
  }
  if (listing.annualRentAed == null) {
    warnings.push({ code: 'rent_missing', message: 'No rent figure, so the yield is unknown.' });
  } else if (!isPriceImplausible(listing) && listing.priceAed > 0) {
    const yieldValue = listing.annualRentAed / listing.priceAed;
    if (yieldValue > MAX_PLAUSIBLE_GROSS_YIELD) {
      warnings.push({
        code: 'yield_implausible',
        message: `Gross yield of ${(yieldValue * 100).toFixed(1)}% is not realistic: the rent or the price is wrong.`,
      });
    }
  }
  return warnings;
}

export function isRecommendable(warnings: ListingWarning[]): boolean {
  return !warnings.some((warning) => BLOCKING.has(warning.code));
}
