import {
  ArrowLeftRight,
  Baby,
  Banknote,
  Beer,
  Bike,
  Book,
  Briefcase,
  Building,
  Bus,
  Car,
  Clapperboard,
  Coffee,
  CreditCard,
  Droplet,
  Dumbbell,
  Flame,
  Fuel,
  Gamepad2,
  Gift,
  GraduationCap,
  HandCoins,
  Hammer,
  HeartPulse,
  House,
  Landmark,
  Laptop,
  Lightbulb,
  PawPrint,
  Percent,
  PiggyBank,
  Pill,
  Pizza,
  Plane,
  Receipt,
  Repeat,
  Scissors,
  Shapes,
  Shirt,
  ShoppingBag,
  ShoppingBasket,
  Smartphone,
  Sofa,
  Sparkles,
  Stethoscope,
  Tag,
  Ticket,
  TrainFront,
  TrendingUp,
  Tv,
  Undo2,
  Utensils,
  Wallet,
  Wifi,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import type { AccountType } from '@/data/database.types'

/** Icon keys stored in categories.icon → components. Unknown keys fall back to a tag. */
export const CATEGORY_ICONS: Record<string, LucideIcon> = {
  utensils: Utensils,
  'shopping-basket': ShoppingBasket,
  bus: Bus,
  'shopping-bag': ShoppingBag,
  receipt: Receipt,
  home: House,
  'heart-pulse': HeartPulse,
  clapperboard: Clapperboard,
  plane: Plane,
  'graduation-cap': GraduationCap,
  sparkles: Sparkles,
  repeat: Repeat,
  gift: Gift,
  shapes: Shapes,
  briefcase: Briefcase,
  laptop: Laptop,
  percent: Percent,
  undo: Undo2,
  car: Car,
  fuel: Fuel,
  coffee: Coffee,
  pizza: Pizza,
  beer: Beer,
  train: TrainFront,
  bike: Bike,
  baby: Baby,
  paw: PawPrint,
  dumbbell: Dumbbell,
  phone: Smartphone,
  wifi: Wifi,
  zap: Zap,
  droplet: Droplet,
  flame: Flame,
  lightbulb: Lightbulb,
  shirt: Shirt,
  book: Book,
  gamepad: Gamepad2,
  tv: Tv,
  ticket: Ticket,
  pill: Pill,
  stethoscope: Stethoscope,
  scissors: Scissors,
  wrench: Wrench,
  hammer: Hammer,
  sofa: Sofa,
  building: Building,
  landmark: Landmark,
  'piggy-bank': PiggyBank,
  wallet: Wallet,
  banknote: Banknote,
  'trending-up': TrendingUp,
  'hand-coins': HandCoins,
  tag: Tag,
}

export const CATEGORY_ICON_KEYS = Object.keys(CATEGORY_ICONS)

export function CategoryGlyph({ icon, className }: { icon: string | null | undefined; className?: string }) {
  const Icon = (icon && CATEGORY_ICONS[icon]) || Tag
  return <Icon aria-hidden="true" className={className ?? 'size-5'} strokeWidth={2.25} />
}

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  bank: 'Bank account',
  cash: 'Cash',
  credit_card: 'Credit card',
  other: 'Other',
}

const ACCOUNT_ICONS: Record<AccountType, LucideIcon> = {
  bank: Landmark,
  cash: Banknote,
  credit_card: CreditCard,
  other: Wallet,
}

export function AccountGlyph({ type, className }: { type: AccountType; className?: string }) {
  const Icon = ACCOUNT_ICONS[type]
  return <Icon aria-hidden="true" className={className ?? 'size-5'} strokeWidth={2.25} />
}

export function TransferGlyph({ className }: { className?: string }) {
  return <ArrowLeftRight aria-hidden="true" className={className ?? 'size-5'} strokeWidth={2.5} />
}
