import { findOriginal, grossYield, isRecommendable, ListingFacts, listingWarnings } from './listing-quality';

function listing(overrides: Partial<ListingFacts>): ListingFacts {
  return {
    id: 'id-1001',
    reference: 'MBR-1001',
    area: 'Dubai Marina',
    building: 'Marina Gate 1',
    type: 'apartment',
    bedrooms: 2,
    sizeSqft: 1320,
    priceAed: 2_050_000,
    annualRentAed: 150_000,
    listedAt: '2026-11-14T10:00:00.000Z',
    ...overrides,
  };
}

describe('listing quality', () => {
  it('computes gross yield as annual rent over price', () => {
    expect(grossYield(listing({}))).toBeCloseTo(150_000 / 2_050_000);
  });

  it('has no yield when the rent is unknown, and says so without blocking the listing', () => {
    const noRent = listing({ annualRentAed: null });
    expect(grossYield(noRent)).toBeNull();
    const warnings = listingWarnings(noRent, []);
    expect(warnings.map((w) => w.code)).toEqual(['rent_missing']);
    expect(isRecommendable(warnings)).toBe(true);
  });

  it('blocks a typo price (MBR-1023: AED 21,500 for a 2-bed) and gives it no yield', () => {
    const typo = listing({ id: 'id-1023', reference: 'MBR-1023', sizeSqft: 1180, priceAed: 21_500, annualRentAed: 140_000 });
    expect(grossYield(typo)).toBeNull();
    const warnings = listingWarnings(typo, []);
    expect(warnings.map((w) => w.code)).toEqual(['price_implausible']);
    expect(isRecommendable(warnings)).toBe(false);
  });

  it('blocks the later copy of a duplicated unit and points to the original (MBR-1024 copies MBR-1001)', () => {
    const original = listing({});
    const copy = listing({ id: 'id-1024', reference: 'MBR-1024', listedAt: '2026-11-22T10:00:00.000Z' });
    expect(findOriginal(copy, [original, copy])?.reference).toBe('MBR-1001');
    expect(findOriginal(original, [original, copy])).toBeNull();
    const warnings = listingWarnings(copy, [original, copy]);
    expect(warnings.map((w) => w.code)).toEqual(['duplicate_listing']);
    expect(warnings[0].message).toContain('MBR-1001');
    expect(isRecommendable(warnings)).toBe(false);
  });

  it('does not call two different units in one building duplicates', () => {
    const a = listing({});
    const b = listing({ id: 'id-1099', reference: 'MBR-1099', sizeSqft: 1400, listedAt: '2026-11-22T10:00:00.000Z' });
    expect(findOriginal(b, [a, b])).toBeNull();
  });

  it('blocks an unrealistic yield even when the price looks fine', () => {
    const wrongRent = listing({ annualRentAed: 900_000 });
    expect(listingWarnings(wrongRent, []).map((w) => w.code)).toEqual(['yield_implausible']);
  });
});
