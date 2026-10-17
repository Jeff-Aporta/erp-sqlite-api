import { defineSchema, defineEntity, pojoOf } from "@Jeff-Aporta/DER/mod.ts";

export const CatalogoSchema = defineSchema({
  columns: {
    icatalogo: { type: "int", pk: true, autoincrement: true },
    nombre: { type: "string", length: 120, nullable: false },
    archivo: { type: "string", length: 200, nullable: false },
    creado: { type: "datetime" },
  },
});

export class Catalogo extends pojoOf(CatalogoSchema) {}

export const CatalogoEntity = defineEntity({
  pojo: Catalogo,
  singular: "catalogo",
  plural: "catalogos",
});
