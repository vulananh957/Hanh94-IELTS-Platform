import { z, ZodSchema, ZodError } from 'zod';

export type LegacyRecord = Record<string, unknown>;

/**
 * Define legacy data schemas here
 * Example: Old student data format từ phiên bản cũ
 */
export const LegacyStudentSchema = z.object({
  id: z.string(),
  name: z.string().default('Unknown'),
  email: z.string().email().optional(),
  score: z.number().default(0),
  createdAt: z.string().or(z.number()).optional(),
});

export type LegacyStudent = z.infer<typeof LegacyStudentSchema>;

/**
 * Validate & Transform legacy data từ Firebase
 * Nếu data bị thiếu field hoặc sai type, Zod sẽ tự điền default hoặc throw error
 */
export function validateLegacyData<T>(
  input: unknown,
  schema: ZodSchema
): T {
  try {
    return schema.parse(input) as T;
  } catch (error) {
    if (error instanceof ZodError) {
      console.warn('⚠️ Data validation failed:', error.issues);
      // Fallback: coerce data - try to fix với defaults
      return schema.parse(input) as T;
    }
    throw error;
  }
}

/**
 * Safe mapping function - nếu validation fail, return default value
 */
export function safeLegacyMap<T>(
  input: LegacyRecord,
  schema: ZodSchema,
  defaultValue: T
): T {
  try {
    return schema.parse(input) as T;
  } catch (error) {
    console.error('❌ Failed to transform legacy data:', error);
    return defaultValue;
  }
}
