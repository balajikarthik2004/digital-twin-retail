import type { Rng } from './random'

/** Retail-flavoured SKU naming so the inspector card reads like a real catalogue. */
const CATEGORIES = [
  { name: 'Dresses', nouns: ['Maxi Dress', 'Summer Midi', 'Evening Gown', 'Shirt Dress', 'Wrap Dress', 'Bodycon Dress'] },
  { name: 'Womenswear', nouns: ['Floral Skirt', 'Denim Jacket', 'Silk Blouse', 'Cotton Leggings', 'Trench Coat', 'Cardigan'] },
  { name: 'Menswear', nouns: ['Chino Pants', 'Polo Shirt', 'Oxford Button-Down', 'Wool Sweater', 'Tailored Suit', 'Puffer Vest'] },
  { name: 'Kids', nouns: ['Graphic Tee', 'School Uniform', 'Toddler Onesie', 'Denim Overalls', 'Winter Parka', 'Pajama Set'] },
  { name: 'Activewear', nouns: ['Yoga Pants', 'Sports Bra', 'Running Shorts', 'Track Jacket', 'Compression Shirt', 'Tennis Skirt'] },
  { name: 'Footwear', nouns: ['Leather Boots', 'Running Sneakers', 'Ballet Flats', 'Platform Heels', 'Canvas Shoes', 'Sandals'] },
  { name: 'Accessories', nouns: ['Leather Belt', 'Sunglasses', 'Silk Scarf', 'Canvas Tote', 'Crossbody Bag', 'Beanie'] },
] as const

const BRANDS = ['Zara', 'H&M', 'Mango', 'Uniqlo', 'Levis', 'Adidas', 'Nike', 'Puma'] as const

export interface CatalogEntry {
  /**
   * Real-world identity, when known — a barcode or item code from an imported
   * catalogue. Left undefined for a synthetic entry, which gets a generated
   * `SKU-000001`-style id instead. Never set by `makeCatalogEntry` itself.
   */
  id?: string
  name: string
  category: string
  /** Real retail price, when known. A synthetic entry gets a random one instead. */
  price?: number
}

export function makeCatalogEntry(rng: Rng): CatalogEntry {
  const cat = rng.pick(CATEGORIES)
  return {
    name: `${rng.pick(BRANDS)} ${rng.pick(cat.nouns)}`,
    category: cat.name,
  }
}
