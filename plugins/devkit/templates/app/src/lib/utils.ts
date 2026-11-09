import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// shadcn/ui と同じクラス結合ヘルパー
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
