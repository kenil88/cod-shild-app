import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return { showForm: Boolean(login) };
};

export default function Index() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>COD Shield — Stop Fake Orders Before They Ship</h1>
        <p className={styles.text}>
          COD Shield automatically scores every cash-on-delivery order using 8
          risk signals — detecting fake orders, repeat RTO customers, and
          high-risk pincodes in real time.
        </p>

        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Install App
            </button>
          </Form>
        )}

        <ul className={styles.list}>
          <li>
            <strong>8 risk signals, scored instantly.</strong> New customer,
            high-RTO pincode, order velocity, past RTO history, unusual
            quantity, incomplete address, multiple addresses, night order —
            all checked on every COD order automatically.
          </li>
          <li>
            <strong>Auto-tag risky orders in Shopify.</strong> High-risk
            orders are tagged{" "}
            <code>cod-high-risk</code> so your ops team can act before
            dispatch. Available on Starter plan and above.
          </li>
          <li>
            <strong>Auto-cancel fraud orders.</strong> Orders scoring above
            your threshold are cancelled automatically — saving courier and
            restocking costs. Available on Growth plan and above.
          </li>
          <li>
            <strong>Track RTO patterns over time.</strong> COD Shield builds a
            pincode-level RTO database from your own orders so future risk
            scores get smarter as your store grows.
          </li>
        </ul>
      </div>
    </div>
  );
}
