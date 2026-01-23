import frappe
from frappe import _
from frappe.utils import flt
import json
from erpnext.controllers.taxes_and_totals import get_itemised_tax


def update_allocated_costs_totals(doc, method=None):
    """
    Calculate and update custom_total_cost and custom_vat_on_costs
    from custom_allocated_landed_cost child table.

    This function can be called:
    - As a hook (validate, before_save, etc.)
    - Directly from other functions
    """
    # Handle both doc (from hook) and doc_name (from direct call)
    if method:
        # Called as hook
        pi_doc = doc
        pi_name = doc.name
        
        # Calculate totals from child table using new fields
        total_cost = 0.0
        total_vat = 0.0

        for row in pi_doc.get("custom_allocated_landed_cost", []):
            total_cost += flt(row.item_base_amount or 0)
            total_vat += flt(row.item_base_tax_amount or 0)

        # Update doc directly
        pi_doc.custom_total_cost = total_cost
        pi_doc.custom_vat_on_costs = total_vat
    else:
        # Called directly - use SQL to avoid loading document and triggering validation
        pi_name = doc
        
        # Calculate totals directly from database using SQL
        totals = frappe.db.sql("""
            SELECT 
                COALESCE(SUM(item_base_amount), 0) as total_cost,
                COALESCE(SUM(item_base_tax_amount), 0) as total_vat
            FROM `tabAllocated Landed Cost`
            WHERE parent = %s
            AND parenttype = 'Purchase Invoice'
            AND parentfield = 'custom_allocated_landed_cost'
        """, (pi_name,), as_dict=True)
        
        if totals and len(totals) > 0:
            total_cost = flt(totals[0].total_cost or 0)
            total_vat = flt(totals[0].total_vat or 0)
        else:
            total_cost = 0.0
            total_vat = 0.0
        
        # Update via db.set_value (doesn't trigger validation)
        frappe.db.set_value("Purchase Invoice", pi_name, {
            "custom_total_cost": total_cost,
            "custom_vat_on_costs": total_vat
        })


@frappe.whitelist()
def recalculate_allocated_costs_from_pi(source_purchase_invoice_name):
    """
    Recalculate Allocated Landed Cost rows in original Purchase Invoice
    from a source Purchase Invoice that has custom_original_purchase_invoice.
    
    Uses base_net_amount directly from database (base currency, item level).
    
    Usage: bench --site all execute aljamil_customizations.purchase_invoice.recalculate_allocated_costs_from_pi --kwargs '{"source_purchase_invoice_name": "ACC-PINV-2026-00052"}'
    """
    if not frappe.db.exists("Purchase Invoice", source_purchase_invoice_name):
        frappe.log_error(f"[purchase_invoice.py] recalculate_allocated_costs_from_pi")
        return False
    
    original_pi_name = frappe.db.get_value("Purchase Invoice", source_purchase_invoice_name, "custom_original_purchase_invoice")
    
    if not original_pi_name:
        frappe.log_error(f"[purchase_invoice.py] recalculate_allocated_costs_from_pi")
        return False
    
    if not frappe.db.exists("Purchase Invoice", original_pi_name):
        frappe.log_error(f"[purchase_invoice.py] recalculate_allocated_costs_from_pi")
        return False
    
    try:
        source_pi = frappe.get_doc("Purchase Invoice", source_purchase_invoice_name)
        source_document_name = source_pi.name
        source_document_type = source_pi.doctype
        
        # Delete only rows created by this Purchase Invoice
        frappe.db.sql("""
            DELETE FROM `tabAllocated Landed Cost`
            WHERE parent = %s
            AND parenttype = 'Purchase Invoice'
            AND parentfield = 'custom_allocated_landed_cost'
            AND source_document_type = %s
            AND source_document = %s
        """, (original_pi_name, source_document_type, source_document_name))
        
        # Get items from source Purchase Invoice using SQL
        # Use base_net_amount directly from database (base currency, item level)
        items_data = frappe.db.sql("""
            SELECT item_code, amount, base_net_amount, item_tax_rate
            FROM `tabPurchase Invoice Item`
            WHERE parent = %s
            AND item_code IS NOT NULL
            AND item_code != ''
            AND base_net_amount > 0
        """, (source_purchase_invoice_name,), as_dict=True)
        
        # Calculate itemised tax from taxes table (for VAT)
        itemised_tax = {}
        if source_pi.get("taxes"):
            itemised_tax = get_itemised_tax(source_pi.taxes)
        
        # Add new row for each item
        for item in items_data:
            item_code = item.item_code
            base_net_amount = flt(item.base_net_amount)
            
            # Calculate item_base_tax_amount from item_tax_rate using base_net_amount (item level tax calculation, base currency)
            item_base_tax_amount = 0.0
            if item.item_tax_rate:
                try:
                    item_tax_map = json.loads(item.item_tax_rate) if isinstance(
                        item.item_tax_rate, str) else item.item_tax_rate
                    if isinstance(item_tax_map, dict):
                        total_tax_rate = sum([flt(rate) for rate in item_tax_map.values()])
                        item_base_tax_amount = flt((base_net_amount * total_tax_rate) / 100.0)
                except (json.JSONDecodeError, TypeError):
                    pass
            
            # If still not found, try to get from itemised_tax (base currency)
            if item_base_tax_amount == 0.0 and itemised_tax.get(item_code):
                for tax_desc, tax_data in itemised_tax[item_code].items():
                    if isinstance(tax_data, dict) and tax_data.get("tax_amount"):
                        base_tax = tax_data.get("base_tax_amount") or tax_data.get("tax_amount", 0)
                        item_base_tax_amount += flt(base_tax, 0)
            
            # Add new row
            allocated_cost = frappe.new_doc("Allocated Landed Cost")
            allocated_cost.parent = original_pi_name
            allocated_cost.parenttype = "Purchase Invoice"
            allocated_cost.parentfield = "custom_allocated_landed_cost"
            allocated_cost.custom_service_item = item_code
            allocated_cost.item_amount = item.amount
            allocated_cost.item_base_amount = item.base_net_amount
            allocated_cost.item_base_tax_amount = item_base_tax_amount
            allocated_cost.source_document_type = source_document_type
            allocated_cost.source_document = source_document_name
            allocated_cost.db_insert()
        
        frappe.db.commit()
        
        # Update totals in original Purchase Invoice
        update_allocated_costs_totals(original_pi_name)
        
        return True
        
    except Exception as e:
        frappe.log_error(f"[purchase_invoice.py] recalculate_allocated_costs_from_pi")
        return False


@frappe.whitelist()
def refresh_allocated_costs_on_open(purchase_invoice_name):
    """
    Refresh Allocated Landed Cost rows when Purchase Invoice is opened.
    Recalculates from:
    - Landed Cost Vouchers (creates rows from LCV taxes and service invoices)
    
    Note: Cost Purchase Invoices are now handled by LCV submit, no need to recalculate separately.
    
    Called from JavaScript on onload event.
    """
    if not purchase_invoice_name:
        return {"updated": False}

    try:
        # Check if Purchase Invoice is submitted - if so, only update totals, don't insert new rows
        pi_docstatus = frappe.db.get_value("Purchase Invoice", purchase_invoice_name, "docstatus")
        if pi_docstatus == 1:
            # Purchase Invoice is submitted - only update totals, don't try to insert new rows
            update_allocated_costs_totals(purchase_invoice_name)
            return {"updated": True, "message": "Purchase Invoice is submitted - only totals updated"}

        # Purchase Invoice is draft - can insert new rows
        # Recalculate from LCVs
        lcv_list = frappe.db.sql("""
            SELECT DISTINCT parent as lcv_name
            FROM `tabLanded Cost Purchase Receipt`
            WHERE receipt_document = %s
            AND receipt_document_type = 'Purchase Invoice'
        """, (purchase_invoice_name,), as_dict=True)
        
        for lcv_row in lcv_list:
            try:
                # Import here to avoid circular import
                from aljamil_customizations.landed_cost_voucher import (
                    update_original_purchase_invoice_allocated_costs_on_submit_landed_cost_voucher
                )
                lcv_doc = frappe.get_doc("Landed Cost Voucher", lcv_row.lcv_name)
                if lcv_doc.docstatus == 1:
                    update_original_purchase_invoice_allocated_costs_on_submit_landed_cost_voucher(lcv_doc, None)
            except:
                pass
        
        # Update totals
        update_allocated_costs_totals(purchase_invoice_name)
        
        return {"updated": True}

    except Exception as e:
        frappe.log_error(f"[purchase_invoice.py] refresh_allocated_costs_on_open")
        return {"updated": False}


@frappe.whitelist()
def refresh_allocated_costs_totals(purchase_invoice_name):
    """
    Refresh and update custom_total_cost and custom_vat_on_costs
    from custom_allocated_landed_cost child table.
    Called from JavaScript on refresh event.
    """
    if not purchase_invoice_name:
        return {"total_cost": 0.0, "total_vat": 0.0}

    try:
        # Call the main function to update totals
        update_allocated_costs_totals(purchase_invoice_name)
        
        # Get updated values to return
        values = frappe.db.get_value(
            "Purchase Invoice",
            purchase_invoice_name,
            ["custom_total_cost", "custom_vat_on_costs"],
            as_dict=True
        )
        
        return {
            "total_cost": flt(values.get("custom_total_cost") or 0),
            "total_vat": flt(values.get("custom_vat_on_costs") or 0)
        }

    except Exception as e:
        frappe.log_error(f"[purchase_invoice.py] refresh_allocated_costs_totals")
        return {"total_cost": 0.0, "total_vat": 0.0}


@frappe.whitelist()
def fetch_landed_costs_from_lcv(purchase_invoice_name):
    """
    Fetch and update allocated costs from related Landed Cost Vouchers.
    Called from button "Fetch Landed Costs" in Purchase Invoice.
    
    Logic:
    1. Find all submitted LCVs related to this Purchase Invoice
    2. For each LCV, update allocated costs (same logic as on_submit)
    3. Update totals
    """
    if not purchase_invoice_name:
        frappe.throw(_("Purchase Invoice name is required"))
    
    if not frappe.db.exists("Purchase Invoice", purchase_invoice_name):
        frappe.throw(_("Purchase Invoice not found"))
    
    pi_docstatus = frappe.db.get_value("Purchase Invoice", purchase_invoice_name, "docstatus")
    if pi_docstatus != 1:
        frappe.throw(_("Purchase Invoice must be submitted first"))
    
    try:
        # Step 1: Delete all existing allocated cost rows for this Purchase Invoice
        # (to prevent duplicates when fetching again)
        frappe.db.sql("""
            DELETE FROM `tabAllocated Landed Cost`
            WHERE parent = %s
            AND parenttype = 'Purchase Invoice'
            AND parentfield = 'custom_allocated_landed_cost'
        """, (purchase_invoice_name,))
        
        # Step 2: Find all submitted LCVs related to this Purchase Invoice
        lcv_list = frappe.db.sql("""
            SELECT DISTINCT parent as lcv_name
            FROM `tabLanded Cost Purchase Receipt`
            WHERE receipt_document = %s
            AND receipt_document_type = 'Purchase Invoice'
        """, (purchase_invoice_name,), as_dict=True)
        
        if not lcv_list:
            frappe.db.commit()
            return {"success": True, "message": _("No related Landed Cost Vouchers found")}
        
        updated_count = 0
        for lcv_row in lcv_list:
            lcv_name = lcv_row.lcv_name
            try:
                # Check if LCV exists and is submitted
                if not frappe.db.exists("Landed Cost Voucher", lcv_name):
                    continue
                
                lcv_docstatus = frappe.db.get_value("Landed Cost Voucher", lcv_name, "docstatus")
                if lcv_docstatus != 1:
                    continue
                
                # Import here to avoid circular import
                from aljamil_customizations.landed_cost_voucher import (
                    update_original_purchase_invoice_allocated_costs_on_submit_landed_cost_voucher
                )
                
                lcv_doc = frappe.get_doc("Landed Cost Voucher", lcv_name)
                update_original_purchase_invoice_allocated_costs_on_submit_landed_cost_voucher(lcv_doc, None)
                updated_count += 1
            except Exception as e:
                frappe.log_error(f"[purchase_invoice.py] fetch_landed_costs_from_lcv - Error processing LCV {lcv_name}")
                continue
        
        frappe.db.commit()
        
        # Step 3: Update totals
        update_allocated_costs_totals(purchase_invoice_name)
        
        return {
            "success": True,
            "message": _("Updated allocated costs from {0} Landed Cost Voucher(s)").format(updated_count)
        }
        
    except Exception as e:
        frappe.log_error(f"[purchase_invoice.py] fetch_landed_costs_from_lcv")
        frappe.throw(_("Error fetching landed costs: {0}").format(str(e)))
