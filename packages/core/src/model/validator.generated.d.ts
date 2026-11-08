export interface ValidationError {
  instancePath: string;
  message?: string;
  params: Record<string, unknown>;
}
export interface Validator {
  (data: unknown): boolean;
  errors: ValidationError[] | null;
}
export const validate: Validator;
export default validate;
