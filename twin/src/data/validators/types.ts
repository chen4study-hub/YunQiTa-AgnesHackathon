export interface SchemaError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Record<string, unknown>;
  message?: string;
}
/** Ajv-compatible boolean schema checker; errors reflect the most recent call. */
export interface SchemaValidator {
  (input: unknown): boolean;
  errors?: SchemaError[] | null;
}
export function validationErrorsText(errors?: SchemaError[] | null): string {
  return errors?.length
    ? errors
        .map((error) => `data${error.instancePath} ${error.message}`)
        .join(", ")
    : "No errors";
}
