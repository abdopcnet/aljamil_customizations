import frappe
from frappe import _
from frappe.utils import flt, today, getdate
import erpnext
from erpnext.accounts.party import get_party_account
from erpnext.setup.utils import get_exchange_rate


# Journal Entry functions removed - Purchase Invoice handles GL entries now


@frappe.whitelist()
def create_purchase_invoices_from_expenses(doc_name):
    """
    Create Purchase Invoices for supplier expenses in Landed Cost Voucher.
    Groups expenses by supplier and creates one Purchase Invoice per supplier.
    """
    doc = frappe.get_doc("Landed Cost Voucher", doc_name)

    if not doc.get("taxes"):
        frappe.throw(_("No taxes and charges found in this document"))

    # Group expenses by supplier and currency
    # Key: (supplier, currency)
    supplier_expenses = {}

    company_currency = erpnext.get_company_currency(doc.company)

    for tax_row in doc.get("taxes"):
        # Only process rows with custom_expense_from_supplier == 1
        if not tax_row.get("custom_expense_from_supplier"):
            continue

        # Skip if Purchase Invoice already exists
        if tax_row.get("custom_expense_purchase_invoice"):
            continue

        supplier = tax_row.get("custom_expense_supplier")
        service_item = tax_row.get("custom_service_item")
        amount = flt(tax_row.get("amount") or tax_row.get("base_amount"))

        # Get currency from account_currency field, fallback to company currency
        account_currency = tax_row.get("account_currency") or company_currency

        if not supplier:
            frappe.throw(
                _("Row {0}: Supplier is required when 'Expense From Supplier' is checked").format(
                    tax_row.idx
                )
            )

        if not service_item:
            frappe.throw(
                _("Row {0}: Service Item is required when 'Expense From Supplier' is checked").format(
                    tax_row.idx
                )
            )

        if not amount:
            continue

        # Group by (supplier, currency) tuple
        key = (supplier, account_currency)
        if key not in supplier_expenses:
            supplier_expenses[key] = []

        supplier_expenses[key].append({
            "tax_row": tax_row,
            "service_item": service_item,
            "amount": amount,
            "base_amount": flt(tax_row.get("base_amount") or amount),
            "description": tax_row.get("description") or "",
            "row_idx": tax_row.idx,
            "account_currency": account_currency
        })

    if not supplier_expenses:
        frappe.throw(_("No supplier expenses found. Please check 'Expense From Supplier' and fill required fields."))

    created_invoices = []
    errors = []

    for key, expenses in supplier_expenses.items():
        supplier, currency = key

        try:
            # Get supplier account
            supplier_account = get_party_account("Supplier", supplier, doc.company)
            if not supplier_account:
                errors.append({
                    "supplier": supplier,
                    "error": _("Supplier Account not found")
                })
                continue

            # Get exchange rate if currency is different from company currency
            if currency != company_currency:
                exchange_rate = get_exchange_rate(
                    from_currency=currency,
                    to_currency=company_currency,
                    transaction_date=doc.posting_date or today(),
                    args="for_buying"
                ) or 1.0
            else:
                exchange_rate = 1.0

            # Create Purchase Invoice
            purchase_invoice = frappe.new_doc("Purchase Invoice")
            purchase_invoice.company = doc.company
            purchase_invoice.supplier = supplier
            purchase_invoice.posting_date = doc.posting_date or today()
            purchase_invoice.currency = currency
            purchase_invoice.conversion_rate = exchange_rate
            purchase_invoice.bill_no = f"LCV-{doc.name}"
            purchase_invoice.bill_date = doc.posting_date or today()

            # Add items - simple: just use custom_service_item and amount
            total_amount = 0
            for exp in expenses:
                # Add item to Purchase Invoice
                # Only use: item_code (custom_service_item), rate (amount), description
                # Let set_missing_values() handle all other required fields automatically
                purchase_invoice.append("items", {
                    "item_code": exp["service_item"],
                    "qty": 1.0,
                    "rate": exp["amount"],
                    "description": exp["description"] or ""
                })

                total_amount += exp["base_amount"]

            # Set missing values
            purchase_invoice.set_missing_values()

            # Save Purchase Invoice (as draft)
            purchase_invoice.insert(ignore_permissions=True)
            purchase_invoice.save(ignore_permissions=True)

            # Update custom_expense_purchase_invoice in all related tax rows
            for exp in expenses:
                frappe.db.set_value(
                    "Landed Cost Taxes and Charges",
                    exp["tax_row"].name,
                    "custom_expense_purchase_invoice",
                    purchase_invoice.name
                )

            frappe.db.commit()

            created_invoices.append({
                "supplier": supplier,
                "currency": currency,
                "invoice": purchase_invoice.name,
                "items_count": len(expenses),
                "total_amount": total_amount
            })

        except Exception as e:
            frappe.db.rollback()
            error_msg = str(e)
            errors.append({
                "supplier": supplier,
                "error": error_msg
            })
            frappe.log_error(
                "[landed_cost_voucher.py] method: create_purchase_invoices_from_expenses - Supplier {0}: {1}".format(
                    supplier, error_msg
                ),
                "Landed Cost Voucher Purchase Invoice Creation Error"
            )
            continue

    # Return result
    result = {
        "created_invoices": created_invoices,
        "errors": errors
    }

    if errors:
        error_msg = _("Some Purchase Invoices could not be created:\n")
        for err in errors:
            error_msg += _("Supplier {0}: {1}\n").format(err["supplier"], err["error"])
        frappe.msgprint(error_msg, alert=True, indicator="orange")

    return result


def update_purchase_invoice_allocated_costs(doc, method):
    """
    Update custom_allocated_landed_cost table in Purchase Invoice
    when Landed Cost Voucher is submitted or cancelled.

    Mapping:
    - Allocated Landed Cost.cost = Landed Cost Taxes and Charges.custom_service_item
    - Allocated Landed Cost.total = Landed Cost Taxes and Charges.base_amount
    Only for rows where custom_expense_from_supplier == 1
    """
    if not doc.get("purchase_receipts"):
        return

    # Get all Purchase Invoices linked to this LCV
    purchase_invoices = set()

    for pr_row in doc.get("purchase_receipts"):
        if pr_row.receipt_document_type == "Purchase Invoice" and pr_row.receipt_document:
            purchase_invoices.add(pr_row.receipt_document)

    # Update each Purchase Invoice
    for purchase_invoice_name in purchase_invoices:
        try:
            # Get all submitted LCVs linked to this Purchase Invoice
            lcv_list = frappe.get_all(
                "Landed Cost Purchase Receipt",
                filters={
                    "receipt_document_type": "Purchase Invoice",
                    "receipt_document": purchase_invoice_name,
                    "docstatus": 1
                },
                fields=["parent"],
                distinct=True
            )

            # Aggregate costs from Landed Cost Taxes and Charges
            # Key: custom_service_item, Value: sum of base_amount
            service_item_costs = {}

            for lcv_row in lcv_list:
                lcv_doc = frappe.get_doc("Landed Cost Voucher", lcv_row.parent)

                # Get taxes rows where custom_expense_from_supplier == 1
                for tax_row in lcv_doc.get("taxes", []):
                    if tax_row.get("custom_expense_from_supplier") and tax_row.get("custom_service_item"):
                        service_item = tax_row.custom_service_item
                        base_amount = flt(tax_row.get("base_amount") or 0)

                        if service_item not in service_item_costs:
                            service_item_costs[service_item] = 0.0
                        service_item_costs[service_item] += base_amount

            # Delete existing allocated costs
            frappe.db.delete("Allocated Landed Cost", {
                "parent": purchase_invoice_name
            })

            # Add new allocated costs using db_insert to avoid triggering GL entries recalculation
            for service_item, total_amount in service_item_costs.items():
                if total_amount > 0:
                    allocated_cost = frappe.new_doc("Allocated Landed Cost")
                    allocated_cost.parent = purchase_invoice_name
                    allocated_cost.parenttype = "Purchase Invoice"
                    allocated_cost.parentfield = "custom_allocated_landed_cost"
                    allocated_cost.cost = service_item
                    allocated_cost.total = total_amount
                    allocated_cost.db_insert()

            frappe.db.commit()

        except Exception as e:
            frappe.db.rollback()
            frappe.log_error(
                "[landed_cost_voucher.py] method: update_purchase_invoice_allocated_costs - "
                "Purchase Invoice {0}: {1}".format(purchase_invoice_name, str(e)),
                "Landed Cost Voucher Update Error"
            )
