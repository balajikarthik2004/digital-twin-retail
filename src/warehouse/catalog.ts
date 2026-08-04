import type { Rng } from './random'

/** Retail-flavoured SKU naming so the inspector card reads like a real catalogue. */
const CATEGORIES = [
  { name: 'Beverages', nouns: ['Cola 12pk', 'Sparkling Water', 'Cold Brew', 'Energy Drink', 'Orange Juice', 'Oat Milk'] },
  { name: 'Snacks', nouns: ['Tortilla Chips', 'Pretzel Bites', 'Trail Mix', 'Protein Bar', 'Salted Cashews', 'Rice Crackers'] },
  { name: 'Household', nouns: ['Paper Towels', 'Dish Soap', 'Laundry Pods', 'Trash Bags', 'Glass Cleaner', 'Sponges 6pk'] },
  { name: 'Personal Care', nouns: ['Shampoo 400ml', 'Body Wash', 'Toothpaste', 'Razor Cartridges', 'Hand Cream', 'Sunscreen SPF50'] },
  { name: 'Pantry', nouns: ['Olive Oil 1L', 'Pasta 500g', 'Basmati Rice', 'Tomato Passata', 'Peanut Butter', 'Breakfast Cereal'] },
  { name: 'Pet', nouns: ['Dry Dog Food', 'Cat Litter', 'Chew Sticks', 'Kitten Pouches', 'Bird Seed', 'Pet Shampoo'] },
  { name: 'Electronics', nouns: ['USB-C Cable', 'AA Batteries', 'Bluetooth Earbuds', 'Phone Case', 'HDMI Lead', 'Power Bank'] },
  { name: 'Apparel', nouns: ['Cotton Tee', 'Ankle Socks 5pk', 'Fleece Hoodie', 'Denim Jeans', 'Running Shorts', 'Beanie Hat'] },
  { name: 'Home & Garden', nouns: ['Potting Mix 10L', 'LED Bulb 4pk', 'Picture Hooks', 'Garden Twine', 'Storage Tote', 'Door Mat'] },
  { name: 'Toys', nouns: ['Building Bricks', 'Puzzle 500pc', 'Plush Bear', 'Card Game', 'Water Blaster', 'Play Dough Set'] },
] as const

const BRANDS = ['Nordvale', 'Harborline', 'Cedarleaf', 'Brightmoor', 'Kestrel', 'Aurora', 'Tallgrass', 'Ironwood'] as const

export interface CatalogEntry {
  name: string
  category: string
}

export function makeCatalogEntry(rng: Rng): CatalogEntry {
  const cat = rng.pick(CATEGORIES)
  return {
    name: `${rng.pick(BRANDS)} ${rng.pick(cat.nouns)}`,
    category: cat.name,
  }
}
