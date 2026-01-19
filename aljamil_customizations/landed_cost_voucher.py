import frappe
from frappe import _
from frappe.utils import flt, today, getdate
import erpnext
from erpnext.accounts.party import get_party_account
from erpnext.setup.utils import get_exchange_rate


# Override the original function by patching the module
def _patch_get_item_account_wise_additional_cost():
    """Patch the original function to exclude supplier expenses"""
    from erpnext.stock.doctype.purchase_receipt import purchase_receipt
    from erpnext.accounts.doctype.purchase_invoice import purchase_invoice

    # Store original function
    _original_function = purchase_receipt.get_item_account_wise_additional_cost

    def patched_get_item_account_wise_additional_cost(purchase_document):
        """Override to exclude expenses from supplier"""
        # Call original function
        result = _original_function(purchase_document)

        if not result:
            return result

        # Get all Landed Cost Vouchers linked to this purchase document
        landed_cost_vouchers = frappe.get_all(
            "Landed Cost Purchase Receipt",
            fields=["parent"],
            filters={"receipt_document": purchase_document, "docstatus": 1},
        )

        if not landed_cost_vouchers:
            return result

        # Build a set of expense accounts that are from suppliers
        supplier_expense_accounts = set()

        for lcv in landed_cost_vouchers:
            landed_cost_voucher_doc = frappe.get_doc("Landed Cost Voucher", lcv.parent)

            # Get list of expense accounts that are from suppliers with Purchase Invoice
            # Purchase Invoice will create GL entries, so we exclude from normal GL entries in PR
            for tax in landed_cost_voucher_doc.taxes:
                if (tax.get("custom_expense_from_supplier") and
                    tax.expense_account and
                        tax.get("custom_expense_purchase_invoice")):
                    # Exclude if Purchase Invoice exists (Purchase Invoice handles GL entries instead of PR)
                    supplier_expense_accounts.add(tax.expense_account)

        # Remove these accounts from the result
        if supplier_expense_accounts:
            keys_to_remove = []
            for key in list(result.keys()):
                for expense_account in supplier_expense_accounts:
                    if expense_account in result[key]:
                        del result[key][expense_account]

                # Mark for removal if item has no expense accounts left
                if not result[key]:
                    keys_to_remove.append(key)

            # Remove empty entries
            for key in keys_to_remove:
                del result[key]

        return result

    # Patch both modules
    purchase_receipt.get_item_account_wise_additional_cost = patched_get_item_account_wise_additional_cost
    purchase_invoice.get_item_account_wise_additional_cost = patched_get_item_account_wise_additional_cost


# Call the patch function when module is imported
_patch_get_item_account_wise_additional_cost()


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


# Journal Entry cancellation function removed - Purchase Invoice handles everything now
