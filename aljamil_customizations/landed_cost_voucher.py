import frappe
from frappe import _
from frappe.utils import flt, today, getdate, cint, add_days
import erpnext
import json
from erpnext.accounts.party import get_party_account
from erpnext.setup.utils import get_exchange_rate
from erpnext.controllers.taxes_and_totals import get_itemised_tax
from aljamil_customizations.purchase_invoice import update_allocated_costs_totals


# Journal Entry functions removed - Purchase Invoice handles GL entries now


def validate_landed_cost_voucher_taxes(doc, method):
    """
    Validate and clean custom_expense_supplier field in taxes table.
    Ensures that if custom_expense_from_supplier is unchecked, custom_expense_supplier is cleared.
    """
    if not doc.get("taxes"):
        return

    for tax_row in doc.get("taxes"):
        is_checked = cint(tax_row.get("custom_expense_from_supplier")) == 1
        has_supplier = tax_row.get("custom_expense_supplier")

        # If checkbox is unchecked, ensure supplier is cleared
        if not is_checked and has_supplier:
            tax_row.custom_expense_supplier = None

        # If checkbox is checked but supplier is empty, this will be caught by mandatory validation
        # We don't uncheck it here to let the user see the error


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
        # Use cint() to properly check checkbox value
        if not cint(tax_row.get("custom_expense_from_supplier")) == 1:
            continue

        # Skip if Purchase Invoice already exists (check both in doc and database)
        existing_invoice = tax_row.get("custom_expense_purchase_invoice")
        if existing_invoice and frappe.db.exists("Purchase Invoice", existing_invoice):
            continue
        
        # Also check database directly in case field wasn't saved yet
        db_invoice = frappe.db.get_value("Landed Cost Taxes and Charges", tax_row.name, "custom_expense_purchase_invoice")
        if db_invoice and frappe.db.exists("Purchase Invoice", db_invoice):
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
            "account_currency": account_currency,
            "warehouse": tax_row.get("custom_supplier_warehouse")
        })

    # Don't throw error if no supplier expenses - just return empty result
    # This allows the function to be called even when there are no supplier expenses
    if not supplier_expenses:
        return {
            "created_invoices": [],
            "errors": []
        }

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

            # Get posting_date from LCV, use today() as fallback only for exchange rate calculation
            posting_date = doc.posting_date or today()
            
            # Get exchange rate if currency is different from company currency
            if currency != company_currency:
                exchange_rate = get_exchange_rate(
                    from_currency=currency,
                    to_currency=company_currency,
                    transaction_date=posting_date,
                    args="for_buying"
                ) or 1.0
            else:
                exchange_rate = 1.0

            # Get original Purchase Invoice from purchase_receipts
            # Use first Purchase Invoice found in purchase_receipts
            original_purchase_invoice = None
            if doc.get("purchase_receipts"):
                for pr_row in doc.get("purchase_receipts"):
                    if pr_row.receipt_document_type == "Purchase Invoice" and pr_row.receipt_document:
                        original_purchase_invoice = pr_row.receipt_document
                        break

            # Create Purchase Invoice
            purchase_invoice = frappe.new_doc("Purchase Invoice")
            purchase_invoice.company = doc.company
            purchase_invoice.supplier = supplier
            purchase_invoice.posting_date = doc.posting_date
            purchase_invoice.transaction_date = doc.posting_date
            # Set due_date to posting_date + 1 day
            if doc.posting_date:
                purchase_invoice.due_date = add_days(doc.posting_date, 1)
            purchase_invoice.currency = currency
            purchase_invoice.conversion_rate = exchange_rate

            # Set custom_original_purchase_invoice from purchase_receipts
            if original_purchase_invoice:
                purchase_invoice.custom_original_purchase_invoice = original_purchase_invoice

            # Get warehouse from first expense (if available) for set_warehouse
            set_warehouse = None
            for exp in expenses:
                if exp.get("warehouse"):
                    set_warehouse = exp["warehouse"]
                    break

            # Set update_stock and set_warehouse if warehouse is available
            if set_warehouse:
                purchase_invoice.update_stock = 1
                purchase_invoice.set_warehouse = set_warehouse

            # Add items - simple: just use custom_service_item and amount
            total_amount = 0
            for exp in expenses:
                # Add item to Purchase Invoice
                # Use: item_code (custom_service_item), rate (amount), description, warehouse (custom_supplier_warehouse)
                item_dict = {
                    "item_code": exp["service_item"],
                    "qty": 1.0,
                    "rate": exp["amount"],
                    "description": exp["description"] or ""
                }

                # Add warehouse from custom_supplier_warehouse if available
                if exp.get("warehouse"):
                    item_dict["warehouse"] = exp["warehouse"]

                purchase_invoice.append("items", item_dict)

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
            frappe.log_error(f"[landed_cost_voucher.py] create_purchase_invoices_from_expenses")
            continue

    # Return result
    return {
        "created_invoices": created_invoices,
        "errors": errors
    }


def update_original_purchase_invoice_allocated_costs_on_submit_landed_cost_voucher(doc, method):
    """
    Update custom_allocated_landed_cost table in original Purchase Invoice
    when Landed Cost Voucher is submitted.

    Logic:
    1. Create Purchase Invoices from cost suppliers (if not already created)
    2. Create rows in original_pi_name from:
       - LCV taxes table (for rows without custom_expense_from_supplier)
       - Service invoices (Purchase Invoices from cost suppliers)
    """
    if not doc.get("purchase_receipts"):
        return

    # Get Purchase Invoice from purchase_receipts - must have exactly one row
    purchase_invoice_name = None
    purchase_invoice_count = 0
    
    for pr_row in doc.get("purchase_receipts"):
        if pr_row.receipt_document_type == "Purchase Invoice" and pr_row.receipt_document:
            purchase_invoice_name = pr_row.receipt_document
            purchase_invoice_count += 1

    # Must have exactly one Purchase Invoice
    if purchase_invoice_count == 0:
        return
    
    if purchase_invoice_count > 1:
        frappe.log_error(f"[landed_cost_voucher.py] update_original_purchase_invoice_allocated_costs_on_submit_landed_cost_voucher")
        return

    try:
        # Step 1: Create Purchase Invoices from cost suppliers (if not already created)
        create_purchase_invoices_from_expenses(doc.name)
        
        # Commit to ensure service invoices are saved before processing
        frappe.db.commit()

        # Step 1.5: Delete existing rows created by this LCV to avoid duplicates
        frappe.db.sql("""
            DELETE FROM `tabAllocated Landed Cost`
            WHERE parent = %s
            AND parenttype = 'Purchase Invoice'
            AND parentfield = 'custom_allocated_landed_cost'
            AND (
                (source_document_type = %s AND source_document = %s)
                OR source_document IN (
                    SELECT DISTINCT custom_expense_purchase_invoice
                    FROM `tabLanded Cost Taxes and Charges`
                    WHERE parent = %s
                    AND custom_expense_purchase_invoice IS NOT NULL
                    AND custom_expense_purchase_invoice != ''
                )
            )
        """, (purchase_invoice_name, doc.doctype, doc.name, doc.name))

        # Get company currency for fallback
        company_currency = erpnext.get_company_currency(doc.company)

        # Step 2: Get ALL taxes with custom_service_item
        taxes_data = frappe.db.sql("""
            SELECT name, amount, base_amount, custom_service_item, 
                   custom_expense_from_supplier, custom_expense_purchase_invoice,
                   account_currency
            FROM `tabLanded Cost Taxes and Charges`
            WHERE parent = %s
            AND custom_service_item IS NOT NULL
            AND custom_service_item != ''
            AND base_amount > 0
        """, (doc.name,), as_dict=True)

        # Collect all rows to be created, then sort by source_document
        rows_to_insert = []

        # Step 3: Create rows from LCV taxes table (for rows without custom_expense_from_supplier)
        for tax in taxes_data:
            # Only create rows for taxes without custom_expense_from_supplier
            # (rows with custom_expense_from_supplier will be handled via service invoices)
            if tax.custom_expense_from_supplier:
                continue

            # Get currency from account_currency, fallback to company currency
            item_currency = tax.account_currency or company_currency

            rows_to_insert.append({
                "custom_service_item": tax.custom_service_item,
                "item_amount": tax.amount,
                "item_base_amount": tax.base_amount,
                "item_base_tax_amount": 0.0,
                "item_currency": item_currency,
                "source_document_type": doc.doctype,
                "source_document": doc.name
            })

        # Step 4: Process service invoices (Purchase Invoices linked via custom_expense_purchase_invoice)
        # Get service invoices with their corresponding account_currency from LCV taxes
        # Use GROUP BY to ensure we get one row per service invoice with its currency
        service_invoices_data = frappe.db.sql("""
            SELECT custom_expense_purchase_invoice, account_currency
            FROM `tabLanded Cost Taxes and Charges`
            WHERE parent = %s
            AND custom_expense_purchase_invoice IS NOT NULL
            AND custom_expense_purchase_invoice != ''
            GROUP BY custom_expense_purchase_invoice, account_currency
        """, (doc.name,), as_dict=True)

        for svc_inv_data in service_invoices_data:
            service_invoice_name = svc_inv_data.custom_expense_purchase_invoice
            # Get currency from LCV tax row (account_currency), fallback to company currency
            service_invoice_currency = svc_inv_data.account_currency or company_currency
            
            # Check if service invoice exists
            if not frappe.db.exists("Purchase Invoice", service_invoice_name):
                frappe.log_error(f"[landed_cost_voucher.py] Service invoice {service_invoice_name} does not exist")
                continue
            
            try:
                service_invoice_doc = frappe.get_doc("Purchase Invoice", service_invoice_name)
            except Exception as e:
                frappe.log_error(f"[landed_cost_voucher.py] Failed to load service invoice {service_invoice_name}: {str(e)}")
                continue
            
            # Submit service invoice if it's still in draft
            if service_invoice_doc.docstatus == 0:
                try:
                    service_invoice_doc.submit()
                    frappe.db.commit()
                    # Reload to get updated data after submit
                    service_invoice_doc = frappe.get_doc("Purchase Invoice", service_invoice_name)
                except Exception as e:
                    frappe.log_error(f"[landed_cost_voucher.py] Failed to submit service invoice {service_invoice_name}: {str(e)}")
                    continue
            
            # Skip if not submitted (shouldn't happen after above, but safety check)
            if service_invoice_doc.docstatus != 1:
                frappe.log_error(f"[landed_cost_voucher.py] Service invoice {service_invoice_name} is not submitted (docstatus={service_invoice_doc.docstatus})")
                continue

            # Get items from service invoice
            # Use net_amount for transaction currency (item_amount), base_net_amount for base currency
            items_data = frappe.db.sql("""
                SELECT item_code, net_amount, base_net_amount, item_tax_rate
                FROM `tabPurchase Invoice Item`
                WHERE parent = %s
                AND item_code IS NOT NULL
                AND item_code != ''
                AND base_net_amount > 0
            """, (service_invoice_name,), as_dict=True)
            
            if not items_data:
                frappe.log_error(f"[landed_cost_voucher.py] No items found for service invoice {service_invoice_name}")
                continue

            # Calculate itemised tax from taxes table (for VAT)
            itemised_tax = {}
            if service_invoice_doc.get("taxes"):
                from erpnext.controllers.taxes_and_totals import get_itemised_tax
                itemised_tax = get_itemised_tax(service_invoice_doc.taxes)

            # Add new row for each item from service invoice
            for item in items_data:
                item_code = item.item_code
                base_net_amount = flt(item.base_net_amount)

                # Calculate item_base_tax_amount from item_tax_rate
                item_base_tax_amount = 0.0
                if item.item_tax_rate:
                    try:
                        import json
                        item_tax_map = json.loads(item.item_tax_rate) if isinstance(
                            item.item_tax_rate, str) else item.item_tax_rate
                        if isinstance(item_tax_map, dict):
                            total_tax_rate = sum([flt(rate) for rate in item_tax_map.values()])
                            item_base_tax_amount = flt((base_net_amount * total_tax_rate) / 100.0)
                    except (json.JSONDecodeError, TypeError):
                        pass

                # If still not found, try to get from itemised_tax
                if item_base_tax_amount == 0.0 and itemised_tax.get(item_code):
                    for tax_desc, tax_data in itemised_tax[item_code].items():
                        if isinstance(tax_data, dict) and tax_data.get("tax_amount"):
                            base_tax = tax_data.get("base_tax_amount") or tax_data.get("tax_amount", 0)
                            item_base_tax_amount += flt(base_tax, 0)

                rows_to_insert.append({
                    "custom_service_item": item_code,
                    "item_amount": item.net_amount,  # Transaction currency amount (USD)
                    "item_base_amount": base_net_amount,
                    "item_base_tax_amount": item_base_tax_amount,
                    "item_currency": service_invoice_currency,  # From LCV tax row account_currency
                    "source_document_type": "Purchase Invoice",
                    "source_document": service_invoice_name
                })

        # Step 5: Sort rows by source_document, then insert with proper idx
        rows_to_insert.sort(key=lambda x: x.get("source_document", ""))
        
        # Get current max idx to continue from existing rows (after deletion)
        max_idx = frappe.db.sql("""
            SELECT COALESCE(MAX(idx), 0) as max_idx
            FROM `tabAllocated Landed Cost`
            WHERE parent = %s
            AND parenttype = 'Purchase Invoice'
            AND parentfield = 'custom_allocated_landed_cost'
        """, (purchase_invoice_name,), as_dict=True)
        
        start_idx = (max_idx[0].max_idx if max_idx and max_idx[0].max_idx else 0) + 1
        
        # Insert rows with idx based on sorted order
        for idx_offset, row_data in enumerate(rows_to_insert, start=0):
            allocated_cost = frappe.new_doc("Allocated Landed Cost")
            allocated_cost.parent = purchase_invoice_name
            allocated_cost.parenttype = "Purchase Invoice"
            allocated_cost.parentfield = "custom_allocated_landed_cost"
            allocated_cost.idx = start_idx + idx_offset
            allocated_cost.custom_service_item = row_data["custom_service_item"]
            allocated_cost.item_amount = row_data["item_amount"]
            allocated_cost.item_base_amount = row_data["item_base_amount"]
            allocated_cost.item_base_tax_amount = row_data["item_base_tax_amount"]
            allocated_cost.item_currency = row_data.get("item_currency") or company_currency
            allocated_cost.source_document_type = row_data["source_document_type"]
            allocated_cost.source_document = row_data["source_document"]
            allocated_cost.db_insert()

        frappe.db.commit()

        # Update totals in Purchase Invoice (wrap in try-except to prevent blocking)
        try:
            update_allocated_costs_totals(purchase_invoice_name)
            frappe.db.commit()
        except Exception as totals_error:
            frappe.log_error(f"[landed_cost_voucher.py] update_allocated_costs_totals failed for {purchase_invoice_name}: {str(totals_error)}")

    except Exception as e:
        frappe.log_error(f"[landed_cost_voucher.py] update_original_purchase_invoice_allocated_costs_on_submit_landed_cost_voucher: {str(e)}")


@frappe.whitelist()
def update_original_purchase_invoice_allocated_costs(lcv_name):
    """
    Manually update custom_allocated_landed_cost table in original Purchase Invoice.
    Called from button "Update Original Invoice" after LCV is submitted.
    
    Logic:
    1. Delete existing rows created by this LCV
    2. Create rows from:
       - LCV taxes table (for rows without custom_expense_from_supplier)
       - Service invoices (Purchase Invoices from cost suppliers)
    """
    doc = frappe.get_doc("Landed Cost Voucher", lcv_name)
    
    if doc.docstatus != 1:
        frappe.throw(_("Landed Cost Voucher must be submitted first"))
    
    if not doc.get("purchase_receipts"):
        frappe.throw(_("No purchase receipts found in this document"))

    # Get Purchase Invoice from purchase_receipts - must have exactly one row
    purchase_invoice_name = None
    purchase_invoice_count = 0
    
    for pr_row in doc.get("purchase_receipts"):
        if pr_row.receipt_document_type == "Purchase Invoice" and pr_row.receipt_document:
            purchase_invoice_name = pr_row.receipt_document
            purchase_invoice_count += 1

    # Must have exactly one Purchase Invoice
    if purchase_invoice_count == 0:
        frappe.throw(_("No Purchase Invoice found in purchase receipts"))
    
    if purchase_invoice_count > 1:
        frappe.throw(_("Multiple Purchase Invoices found. Only one is supported."))

    try:
        # Get company currency for fallback
        company_currency = erpnext.get_company_currency(doc.company)

        # Step 1: Delete existing rows created by this LCV
        frappe.db.sql("""
            DELETE FROM `tabAllocated Landed Cost`
            WHERE parent = %s
            AND parenttype = 'Purchase Invoice'
            AND parentfield = 'custom_allocated_landed_cost'
            AND (
                (source_document_type = %s AND source_document = %s)
                OR source_document IN (
                    SELECT DISTINCT custom_expense_purchase_invoice
                    FROM `tabLanded Cost Taxes and Charges`
                    WHERE parent = %s
                    AND custom_expense_purchase_invoice IS NOT NULL
                    AND custom_expense_purchase_invoice != ''
                )
            )
        """, (purchase_invoice_name, doc.doctype, doc.name, doc.name))

        # Step 2: Get ALL taxes with custom_service_item
        taxes_data = frappe.db.sql("""
            SELECT name, amount, base_amount, custom_service_item, 
                   custom_expense_from_supplier, custom_expense_purchase_invoice,
                   account_currency
            FROM `tabLanded Cost Taxes and Charges`
            WHERE parent = %s
            AND custom_service_item IS NOT NULL
            AND custom_service_item != ''
            AND base_amount > 0
        """, (doc.name,), as_dict=True)

        # Collect all rows to be created, then sort by source_document
        rows_to_insert = []

        # Step 3: Create rows from LCV taxes table (for rows without custom_expense_from_supplier)
        for tax in taxes_data:
            # Only create rows for taxes without custom_expense_from_supplier
            # (rows with custom_expense_from_supplier will be handled via service invoices)
            if tax.custom_expense_from_supplier:
                continue

            # Get currency from account_currency, fallback to company currency
            item_currency = tax.account_currency or company_currency

            rows_to_insert.append({
                "custom_service_item": tax.custom_service_item,
                "item_amount": tax.amount,
                "item_base_amount": tax.base_amount,
                "item_base_tax_amount": 0.0,
                "item_currency": item_currency,
                "source_document_type": doc.doctype,
                "source_document": doc.name
            })

        # Step 4: Process service invoices (Purchase Invoices linked via custom_expense_purchase_invoice)
        # Get service invoices with their corresponding account_currency from LCV taxes
        # Use GROUP BY to ensure we get one row per service invoice with its currency
        service_invoices_data = frappe.db.sql("""
            SELECT custom_expense_purchase_invoice, account_currency
            FROM `tabLanded Cost Taxes and Charges`
            WHERE parent = %s
            AND custom_expense_purchase_invoice IS NOT NULL
            AND custom_expense_purchase_invoice != ''
            GROUP BY custom_expense_purchase_invoice, account_currency
        """, (doc.name,), as_dict=True)

        for svc_inv_data in service_invoices_data:
            service_invoice_name = svc_inv_data.custom_expense_purchase_invoice
            # Get currency from LCV tax row (account_currency), fallback to company currency
            service_invoice_currency = svc_inv_data.account_currency or company_currency
            
            # Check if service invoice exists
            if not frappe.db.exists("Purchase Invoice", service_invoice_name):
                frappe.log_error(f"[landed_cost_voucher.py] Service invoice {service_invoice_name} does not exist")
                continue
            
            try:
                service_invoice_doc = frappe.get_doc("Purchase Invoice", service_invoice_name)
            except Exception as e:
                frappe.log_error(f"[landed_cost_voucher.py] Failed to load service invoice {service_invoice_name}: {str(e)}")
                continue
            
            # Submit service invoice if it's still in draft
            if service_invoice_doc.docstatus == 0:
                try:
                    service_invoice_doc.submit()
                    frappe.db.commit()
                    # Reload to get updated data after submit
                    service_invoice_doc = frappe.get_doc("Purchase Invoice", service_invoice_name)
                except Exception as e:
                    frappe.log_error(f"[landed_cost_voucher.py] Failed to submit service invoice {service_invoice_name}: {str(e)}")
                    continue
            
            # Skip if not submitted (shouldn't happen after above, but safety check)
            if service_invoice_doc.docstatus != 1:
                frappe.log_error(f"[landed_cost_voucher.py] Service invoice {service_invoice_name} is not submitted (docstatus={service_invoice_doc.docstatus})")
                continue

            # Get items from service invoice
            # Use net_amount for transaction currency (item_amount), base_net_amount for base currency
            items_data = frappe.db.sql("""
                SELECT item_code, net_amount, base_net_amount, item_tax_rate
                FROM `tabPurchase Invoice Item`
                WHERE parent = %s
                AND item_code IS NOT NULL
                AND item_code != ''
                AND base_net_amount > 0
            """, (service_invoice_name,), as_dict=True)
            
            if not items_data:
                frappe.log_error(f"[landed_cost_voucher.py] No items found for service invoice {service_invoice_name}")
                continue

            # Calculate itemised tax from taxes table (for VAT)
            itemised_tax = {}
            if service_invoice_doc.get("taxes"):
                from erpnext.controllers.taxes_and_totals import get_itemised_tax
                itemised_tax = get_itemised_tax(service_invoice_doc.taxes)

            # Add new row for each item from service invoice
            for item in items_data:
                item_code = item.item_code
                base_net_amount = flt(item.base_net_amount)

                # Calculate item_base_tax_amount from item_tax_rate
                item_base_tax_amount = 0.0
                if item.item_tax_rate:
                    try:
                        import json
                        item_tax_map = json.loads(item.item_tax_rate) if isinstance(
                            item.item_tax_rate, str) else item.item_tax_rate
                        if isinstance(item_tax_map, dict):
                            total_tax_rate = sum([flt(rate) for rate in item_tax_map.values()])
                            item_base_tax_amount = flt((base_net_amount * total_tax_rate) / 100.0)
                    except (json.JSONDecodeError, TypeError):
                        pass

                # If still not found, try to get from itemised_tax
                if item_base_tax_amount == 0.0 and itemised_tax.get(item_code):
                    for tax_desc, tax_data in itemised_tax[item_code].items():
                        if isinstance(tax_data, dict) and tax_data.get("tax_amount"):
                            base_tax = tax_data.get("base_tax_amount") or tax_data.get("tax_amount", 0)
                            item_base_tax_amount += flt(base_tax, 0)

                rows_to_insert.append({
                    "custom_service_item": item_code,
                    "item_amount": item.net_amount,  # Transaction currency amount (USD)
                    "item_base_amount": base_net_amount,
                    "item_base_tax_amount": item_base_tax_amount,
                    "item_currency": service_invoice_currency,  # From LCV tax row account_currency
                    "source_document_type": "Purchase Invoice",
                    "source_document": service_invoice_name
                })

        # Step 5: Sort rows by source_document, then insert with proper idx
        rows_to_insert.sort(key=lambda x: x.get("source_document", ""))
        
        # Get current max idx to continue from existing rows (after deletion)
        max_idx = frappe.db.sql("""
            SELECT COALESCE(MAX(idx), 0) as max_idx
            FROM `tabAllocated Landed Cost`
            WHERE parent = %s
            AND parenttype = 'Purchase Invoice'
            AND parentfield = 'custom_allocated_landed_cost'
        """, (purchase_invoice_name,), as_dict=True)
        
        start_idx = (max_idx[0].max_idx if max_idx and max_idx[0].max_idx else 0) + 1
        
        # Insert rows with idx based on sorted order
        for idx_offset, row_data in enumerate(rows_to_insert, start=0):
            allocated_cost = frappe.new_doc("Allocated Landed Cost")
            allocated_cost.parent = purchase_invoice_name
            allocated_cost.parenttype = "Purchase Invoice"
            allocated_cost.parentfield = "custom_allocated_landed_cost"
            allocated_cost.idx = start_idx + idx_offset
            allocated_cost.custom_service_item = row_data["custom_service_item"]
            allocated_cost.item_amount = row_data["item_amount"]
            allocated_cost.item_base_amount = row_data["item_base_amount"]
            allocated_cost.item_base_tax_amount = row_data["item_base_tax_amount"]
            allocated_cost.item_currency = row_data.get("item_currency") or company_currency
            allocated_cost.source_document_type = row_data["source_document_type"]
            allocated_cost.source_document = row_data["source_document"]
            allocated_cost.db_insert()

        frappe.db.commit()

        # Update totals in Purchase Invoice (wrap in try-except to prevent blocking)
        try:
            update_allocated_costs_totals(purchase_invoice_name)
            frappe.db.commit()
        except Exception as totals_error:
            frappe.log_error(f"[landed_cost_voucher.py] update_allocated_costs_totals failed for {purchase_invoice_name}: {str(totals_error)}")
        
        return {"success": True, "message": _("Original Purchase Invoice updated successfully")}

    except Exception as e:
        frappe.log_error(f"[landed_cost_voucher.py] update_original_purchase_invoice_allocated_costs: {str(e)}")
        frappe.throw(_("Error updating Original Purchase Invoice: {0}").format(str(e)))


def update_original_purchase_invoice_allocated_costs_on_cancel_landed_cost_voucher(doc, method):
    """
    Update custom_allocated_landed_cost table in original Purchase Invoice
    when Landed Cost Voucher is cancelled.

    Logic:
    1. Cancel cost invoices (Purchase Invoices from cost suppliers)
    2. Delete all rows created by this LCV and its service invoices
    """
    if not doc.get("purchase_receipts"):
        return

    # Get Purchase Invoice from purchase_receipts
    purchase_invoice_name = None
    for pr_row in doc.get("purchase_receipts"):
        if pr_row.receipt_document_type == "Purchase Invoice" and pr_row.receipt_document:
            purchase_invoice_name = pr_row.receipt_document
            break

    if not purchase_invoice_name:
        return

    try:
        # Step 1: Get service invoices (cost invoices) linked to this LCV
        service_invoices = frappe.db.sql("""
            SELECT DISTINCT custom_expense_purchase_invoice
            FROM `tabLanded Cost Taxes and Charges`
            WHERE parent = %s
            AND custom_expense_purchase_invoice IS NOT NULL
            AND custom_expense_purchase_invoice != ''
        """, (doc.name,), as_dict=True)

        # Step 2: Cancel cost invoices first
        for svc_inv in service_invoices:
            cost_invoice_name = svc_inv.custom_expense_purchase_invoice
            if frappe.db.exists("Purchase Invoice", cost_invoice_name):
                try:
                    cost_invoice_doc = frappe.get_doc("Purchase Invoice", cost_invoice_name)
                    if cost_invoice_doc.docstatus == 1:
                        cost_invoice_doc.cancel()
                        frappe.db.commit()
                except Exception as e:
                    frappe.log_error(f"[landed_cost_voucher.py] Failed to cancel cost invoice {cost_invoice_name}")

        # Step 3: Delete rows created by this LCV
        frappe.db.sql("""
            DELETE FROM `tabAllocated Landed Cost`
            WHERE parent = %s
            AND parenttype = 'Purchase Invoice'
            AND parentfield = 'custom_allocated_landed_cost'
            AND source_document_type = %s
            AND source_document = %s
        """, (purchase_invoice_name, doc.doctype, doc.name))

        # Step 4: Delete rows from service invoices
        for svc_inv in service_invoices:
            frappe.db.sql("""
                DELETE FROM `tabAllocated Landed Cost`
                WHERE parent = %s
                AND parenttype = 'Purchase Invoice'
                AND parentfield = 'custom_allocated_landed_cost'
                AND source_document_type = 'Purchase Invoice'
                AND source_document = %s
            """, (purchase_invoice_name, svc_inv.custom_expense_purchase_invoice))

        frappe.db.commit()

        # Update totals in Purchase Invoice (wrap in try-except to prevent blocking)
        try:
            update_allocated_costs_totals(purchase_invoice_name)
            frappe.db.commit()
        except Exception as totals_error:
            frappe.log_error(f"[landed_cost_voucher.py] update_allocated_costs_totals failed for {purchase_invoice_name}: {str(totals_error)}")

    except Exception as e:
        frappe.log_error(f"[landed_cost_voucher.py] update_original_purchase_invoice_allocated_costs_on_cancel_landed_cost_voucher: {str(e)}")




@frappe.whitelist()
def recalculate_allocated_costs_for_invoice(purchase_invoice_name):
    """
    Recalculate Allocated Landed Cost rows for a specific Purchase Invoice
    from all linked Landed Cost Vouchers.
    
    Usage: bench --site all execute aljamil_customizations.landed_cost_voucher.recalculate_allocated_costs_for_invoice --kwargs '{"purchase_invoice_name": "ACC-PINV-2026-00050"}'
    """
    if not frappe.db.exists("Purchase Invoice", purchase_invoice_name):
        frappe.log_error(f"[landed_cost_voucher.py] recalculate_allocated_costs_for_invoice")
        return
    
    # Get all LCVs linked to this Purchase Invoice
    lcv_list = frappe.db.sql("""
        SELECT DISTINCT parent as lcv_name
        FROM `tabLanded Cost Purchase Receipt`
        WHERE receipt_document = %s
        AND receipt_document_type = 'Purchase Invoice'
    """, (purchase_invoice_name,), as_dict=True)
    
    if not lcv_list:
        return
    
    # Recalculate for each LCV
    for lcv_row in lcv_list:
        lcv_name = lcv_row.lcv_name
        try:
            lcv_doc = frappe.get_doc("Landed Cost Voucher", lcv_name)
            update_original_purchase_invoice_allocated_costs_on_submit_landed_cost_voucher(lcv_doc, None)
        except Exception as e:
            frappe.log_error(f"[landed_cost_voucher.py] recalculate_allocated_costs_for_invoice")
    
    # Also recalculate from cost Purchase Invoices
    cost_invoices = frappe.db.sql("""
        SELECT name
        FROM `tabPurchase Invoice`
        WHERE custom_original_purchase_invoice = %s
        AND docstatus = 1
    """, (purchase_invoice_name,), as_dict=True)
    
    for cost_inv in cost_invoices:
        try:
            # Import here to avoid circular import
            from aljamil_customizations.purchase_invoice import (
                update_original_purchase_invoice_allocated_costs_on_submit_cost_purchase_invoice
            )
            cost_pi = frappe.get_doc("Purchase Invoice", cost_inv.name)
            update_original_purchase_invoice_allocated_costs_on_submit_cost_purchase_invoice(cost_pi, None)
        except Exception as e:
            frappe.log_error(f"[landed_cost_voucher.py] recalculate_allocated_costs_for_invoice")
