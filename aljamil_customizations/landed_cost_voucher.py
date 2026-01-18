import frappe
from frappe import _
from frappe.utils import flt
import erpnext
from erpnext.accounts.party import get_party_account


def create_expense_journal_entries(doc, method):
    """Create Journal Entries for expense rows with supplier when Landed Cost Voucher is submitted"""

    if doc.doctype != "Landed Cost Voucher":
        return

    if not doc.get("taxes"):
        return

    company_currency = erpnext.get_company_currency(doc.company)

    for tax_row in doc.get("taxes"):
        # Check if custom fields are set
        custom_expense_from_supplier = tax_row.get("custom_expense_from_supplier")
        custom_expense_supplier = tax_row.get("custom_expense_supplier")

        # Skip if conditions are not met
        if not custom_expense_from_supplier or not custom_expense_supplier:
            continue

        # Validate expense account
        if not tax_row.expense_account:
            frappe.throw(
                _("Row {0}: Expense Account is required when 'Expense From Supplier' is checked").format(
                    tax_row.idx
                ),
                title=_("Missing Expense Account")
            )

        # Get supplier account
        try:
            supplier_account = get_party_account("Supplier", custom_expense_supplier, doc.company)
            if not supplier_account:
                frappe.throw(
                    _("Row {0}: Supplier Account not found for Supplier {1}").format(
                        tax_row.idx, frappe.bold(custom_expense_supplier)
                    ),
                    title=_("Supplier Account Missing")
                )
        except Exception as e:
            frappe.throw(
                _("Row {0}: Error getting supplier account: {1}").format(tax_row.idx, str(e)),
                title=_("Supplier Account Error")
            )

        # Get account currencies
        expense_account_currency = frappe.get_cached_value(
            "Account", tax_row.expense_account, "account_currency") or company_currency
        supplier_account_currency = frappe.get_cached_value(
            "Account", supplier_account, "account_currency") or company_currency

        # Get amounts
        base_amount = flt(tax_row.base_amount or tax_row.amount)
        amount = flt(tax_row.amount)
        exchange_rate = flt(tax_row.exchange_rate or 1)

        if not base_amount:
            continue

        # Calculate amounts in account currency
        expense_debit_in_account_currency = amount if expense_account_currency != company_currency else base_amount
        supplier_credit_in_account_currency = amount if supplier_account_currency != company_currency else base_amount

        # Create Journal Entry
        journal_entry = frappe.new_doc("Journal Entry")
        journal_entry.posting_date = doc.posting_date
        journal_entry.company = doc.company
        journal_entry.voucher_type = "Journal Entry"

        # Get receipt document numbers from purchase_receipts table
        receipt_documents = []
        if doc.get("purchase_receipts"):
            for pr in doc.get("purchase_receipts"):
                if pr.receipt_document:
                    receipt_documents.append(pr.receipt_document)

        # Set remark in Arabic with receipt document numbers
        description_text = tax_row.description or ""
        if receipt_documents:
            receipt_docs_str = ", ".join(receipt_documents)
            journal_entry.user_remark = "قيد رسوم ضرائب فاتورة مشتريات - {0} - {1}".format(
                receipt_docs_str, description_text
            )
        else:
            journal_entry.user_remark = "قيد رسوم ضرائب فاتورة مشتريات - {0}".format(
                description_text
            )

        # Debit: Expense Account
        journal_entry.append("accounts", {
            "account": tax_row.expense_account,
            "debit_in_account_currency": expense_debit_in_account_currency,
            "debit": base_amount,
            "account_currency": expense_account_currency,
            "exchange_rate": exchange_rate if expense_account_currency != company_currency else 1,
            "party_type": None,
            "party": None,
        })

        # Credit: Supplier Account
        journal_entry.append("accounts", {
            "account": supplier_account,
            "credit_in_account_currency": supplier_credit_in_account_currency,
            "credit": base_amount,
            "account_currency": supplier_account_currency,
            "exchange_rate": exchange_rate if supplier_account_currency != company_currency else 1,
            "party_type": "Supplier",
            "party": custom_expense_supplier,
        })

        # Save and submit Journal Entry
        try:
            journal_entry.insert(ignore_permissions=True)
            journal_entry.submit()

            # Update custom_expense_journal_entry field in tax_row
            frappe.db.set_value(
                "Landed Cost Taxes and Charges",
                tax_row.name,
                "custom_expense_journal_entry",
                journal_entry.name
            )
            frappe.db.commit()

        except Exception as e:
            frappe.db.rollback()
            frappe.log_error(
                "[landed_cost_voucher.py] method: create_expense_journal_entries",
                "Landed Cost Voucher Journal Entry Error"
            )
            frappe.throw(
                _("Row {0}: Error creating Journal Entry: {1}").format(tax_row.idx, str(e)),
                title=_("Journal Entry Creation Error")
            )


def cancel_expense_journal_entries(doc, method):
    """Cancel all Journal Entries created for expense rows when Landed Cost Voucher is cancelled"""

    if doc.doctype != "Landed Cost Voucher":
        return

    if not doc.get("taxes"):
        return

    for tax_row in doc.get("taxes"):
        # Get Journal Entry name from custom field
        journal_entry_name = tax_row.get("custom_expense_journal_entry")

        if not journal_entry_name:
            continue

        # Check if Journal Entry exists and is submitted
        try:
            je_docstatus = frappe.db.get_value("Journal Entry", journal_entry_name, "docstatus")
            if je_docstatus == 1:  # Only cancel if submitted
                journal_entry = frappe.get_doc("Journal Entry", journal_entry_name)
                journal_entry.cancel()
                frappe.db.commit()
        except frappe.DoesNotExistError:
            # Journal Entry doesn't exist, skip
            continue
        except Exception as e:
            frappe.db.rollback()
            frappe.log_error(
                "[landed_cost_voucher.py] method: cancel_expense_journal_entries",
                "Landed Cost Voucher Journal Entry Cancel Error"
            )
            # Continue with other Journal Entries even if one fails
            continue
