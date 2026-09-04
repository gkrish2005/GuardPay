export interface Product {
  id: string;
  name: string;
  price: number; // in Rupees
  description: string;
  category: "shoes" | "accessories" | "apparel";
}

export const PRODUCT_CATALOG: Product[] = [
  { id: "prod_1", name: "Alphafly 3 Running Shoes", price: 15000, description: "Premium marathon racing shoes.", category: "shoes" },
  { id: "prod_2", name: "Vaporfly 3 Running Shoes", price: 12000, description: "Elite road racing shoe.", category: "shoes" },
  { id: "prod_3", name: "Pegasus 41 Running Shoes", price: 8000, description: "Daily road running shoes.", category: "shoes" },
  { id: "prod_4", name: "InfinityRN 4 Running Shoes", price: 6500, description: "High-cushion supportive running shoe.", category: "shoes" },
  { id: "prod_5", name: "Dry-Fit Cushion Running Socks", price: 800, description: "Moisture-wicking athletic socks.", category: "accessories" },
  { id: "prod_6", name: "Reflective Hydration Belt", price: 1200, description: "Adjustable running belt with water bottles.", category: "accessories" },
  { id: "prod_7", name: "Lightweight Runner's Cap", price: 900, description: "Breathable and UV-protective running hat.", category: "accessories" },
  { id: "prod_8", name: "Energy Gel Multipack (6-Pack)", price: 600, description: "Quick-release carbohydrates for runners.", category: "accessories" }
];
