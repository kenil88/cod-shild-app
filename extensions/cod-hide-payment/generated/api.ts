/**
 * Manually authored to match src/run.graphql until `shopify app function typegen`
 * is run — after running typegen this file will be overwritten with the
 * authoritative generated version. Do not rename the exported types.
 */

type ProductVariantMerchandise = {
  __typename: "ProductVariant";
  product: { id: string };
};

type OtherMerchandise = {
  __typename: "CustomProduct";
};

export type RunInput = {
  cart: {
    cost: {
      totalAmount: {
        /** Decimal scalar — always a numeric string, e.g. "1999.00" */
        amount: string;
      };
    };
    lines: Array<{
      merchandise: ProductVariantMerchandise | OtherMerchandise;
    }>;
    /**
     * Present only after the buyer has completed the shipping-address step.
     * The array itself may be empty, and each entry's deliveryAddress may be null
     * (known Shopify behaviour on hard checkout refresh).
     */
    deliveryGroups: Array<{
      deliveryAddress: {
        zip: string | null;
      } | null;
    }>;
  };
  paymentMethods: Array<{
    id: string;
    name: string;
  }>;
  paymentCustomization: {
    /** null when the merchant hasn't saved a config yet */
    metafield: {
      jsonValue: unknown;
    } | null;
  };
};

export type FunctionRunResult = {
  operations: Array<{
    hide: { paymentMethodId: string };
  }>;
};
