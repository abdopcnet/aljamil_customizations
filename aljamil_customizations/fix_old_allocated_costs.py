"""
Script to fix old Allocated Landed Cost rows that don't have source_document fields.
Run with: bench --site all execute aljamil_customizations.landed_cost_voucher.fix_old_allocated_costs
"""
import frappe
from frappe.utils import flt


def fix_old_allocated_costs():
	"""
	Update old Allocated Landed Cost rows that don't have source_document_type and source_document.
	This fixes rows created before the source_document fields were added.
	"""
	# Find all rows without source_document
	rows_to_fix = frappe.get_all(
		"Allocated Landed Cost",
		filters={
			"source_document_type": ["is", "not set"],
			"source_document": ["is", "not set"]
		},
		fields=["name", "parent", "parenttype", "cost", "total", "vat", "creation"]
	)

	if not rows_to_fix:
		frappe.msgprint("No rows to fix.")
		return

	frappe.msgprint(f"Found {len(rows_to_fix)} rows to fix.")

	# Group by parent to find source Purchase Invoices
	parent_map = {}
	for row in rows_to_fix:
		if row.parent not in parent_map:
			parent_map[row.parent] = []

		# Find Purchase Invoices that reference this parent as custom_original_purchase_invoice
		# and were created around the same time as the row
		source_invoices = frappe.get_all(
			"Purchase Invoice",
			filters={
				"custom_original_purchase_invoice": row.parent,
				"docstatus": 1
			},
			fields=["name", "creation"],
			order_by="creation"
		)

		# Match rows to source invoices by creation time and item
		# For simplicity, we'll match by creation time proximity
		best_match = None
		min_time_diff = None

		for invoice in source_invoices:
			# Calculate time difference
			row_time = frappe.utils.get_datetime(row.creation)
			invoice_time = frappe.utils.get_datetime(invoice.creation)
			time_diff = abs((row_time - invoice_time).total_seconds())

			# Check if this invoice has items matching the row
			invoice_items = frappe.get_all(
				"Purchase Invoice Item",
				filters={"parent": invoice.name, "item_code": row.cost},
				fields=["name"]
			)

			if invoice_items:
				if best_match is None or time_diff < min_time_diff:
					best_match = invoice.name
					min_time_diff = time_diff

		if best_match:
			# Update the row
			frappe.db.set_value(
				"Allocated Landed Cost",
				row.name,
				{
					"source_document_type": "Purchase Invoice",
					"source_document": best_match
				}
			)
			frappe.msgprint(f"Updated row {row.name} with source {best_match}")

	frappe.db.commit()
	frappe.msgprint("Fix completed.")


@frappe.whitelist()
def fix_old_allocated_costs_for_invoice(purchase_invoice_name):
	"""
	Fix old Allocated Landed Cost rows for a specific Purchase Invoice.
	This is more accurate as it matches items directly.
	"""
	if not frappe.db.exists("Purchase Invoice", purchase_invoice_name):
		frappe.throw(f"Purchase Invoice {purchase_invoice_name} not found")

	pi = frappe.get_doc("Purchase Invoice", purchase_invoice_name)
	original_pi_name = pi.get("custom_original_purchase_invoice")

	if not original_pi_name:
		frappe.throw(f"Purchase Invoice {purchase_invoice_name} does not have custom_original_purchase_invoice")

	# Get items from this Purchase Invoice
	items_map = {}
	for item in pi.get("items", []):
		if item.item_code:
			items_map[item.item_code] = {
				"net_amount": flt(item.net_amount),
				"item_name": item.item_name
			}

	# Find rows in original PI that match these items but don't have source_document
	rows_to_fix = frappe.get_all(
		"Allocated Landed Cost",
		filters={
			"parent": original_pi_name,
			"parenttype": "Purchase Invoice",
			"parentfield": "custom_allocated_landed_cost",
			"source_document_type": ["is", "not set"],
			"source_document": ["is", "not set"],
			"cost": ["in", list(items_map.keys())]
		},
		fields=["name", "cost", "total", "vat"]
	)

	if not rows_to_fix:
		frappe.msgprint(f"No rows to fix for {purchase_invoice_name}.")
		return

	# Update rows
	for row in rows_to_fix:
		frappe.db.set_value(
			"Allocated Landed Cost",
			row.name,
			{
				"source_document_type": "Purchase Invoice",
				"source_document": purchase_invoice_name
			}
		)

	frappe.db.commit()
	frappe.msgprint(f"Fixed {len(rows_to_fix)} rows for {purchase_invoice_name}.")
