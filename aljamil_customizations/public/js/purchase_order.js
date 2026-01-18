(function () {
// Multi Add for Purchase Order (native items table)
frappe.ui.form.on('Purchase Order', {
	refresh(frm) {
		if (!frm.fields_dict.items) return;
		const grid = frm.fields_dict.items.grid;
		if (!grid) return;

		if (frm.doc && frm.doc.docstatus === 1) {
			if (frm._multi_add_button_po && frm._multi_add_button_po.remove) {
				try { frm._multi_add_button_po.remove(); } catch (e) {}
				frm._multi_add_button_po = null;
				frm._multi_add_button_added_po = false;
			}
			return;
		}

		if (!frm._multi_add_button_added_po) {
			frm._multi_add_button_po = grid.add_custom_button(
				__('📦 Multi Add Items'),
				function () { open_multi_add_dialog_for_native_table_po(frm); },
				'bottom'
			);
			frm._multi_add_button_added_po = true;
		}
	}
});

function open_multi_add_dialog_for_native_table_po(frm) {
	console.log('[purchase_Order.js] open_multi_add_dialog_for_native_table_po');
	const default_wh = frm.doc.set_warehouse || '';

	const d = new frappe.ui.Dialog({
		title: __('Multi Add Items'),
		size: 'large',
		fields: [
			{ fieldname: 'warehouse', label: 'Warehouse', fieldtype: 'Link', options: 'Warehouse', default: default_wh, reqd: 1 },
			{ fieldname: 'search', label: 'Search Item (code / name)', fieldtype: 'Data' },
			{ fieldname: 'results', fieldtype: 'HTML' }
		],
		primary_action_label: __('Add Selected'),
		primary_action(values) {
			if (!frm.doc.supplier) {
				frappe.msgprint({ message: __('Please select Supplier first'), indicator: 'red' });
				return;
			}

			const $tbody = $(d.get_field('results').$wrapper).find('tbody');
			const rows_to_add = [];
			$tbody.find('tr[data-item-code]').each(function () {
				const $r = $(this);
				const qty = parseFloat($r.find('.multi-qty').val()) || 0;
				const item_code = $r.attr('data-item-code');
				if (!qty || qty <= 0) return;
				if (!item_code) return;
				rows_to_add.push({ item_code, qty, warehouse: values.warehouse || '' });
			});

			frm._multi_adding = true;
			const created_children = [];
			rows_to_add.forEach((row_data) => {
				const child = frm.add_child('items');
				child.qty = row_data.qty;
				child.warehouse = row_data.warehouse || frm.doc.set_warehouse || '';
				child.delivery_date = frm.doc.delivery_date || frm.doc.transaction_date || frappe.datetime.nowdate();
				child.item_code = row_data.item_code;
				created_children.push(child);
			});

			frm.refresh_field('items');

			const set_promises = created_children.map((child) =>
				frappe.model.set_value(child.doctype, child.name, 'item_code', child.item_code)
					.then(() => {
						try { return frm.script_manager.trigger('item_code', child.doctype, child.name); } catch (e) { return Promise.resolve(); }
					})
			);

			Promise.all(set_promises).then(() => {
				frm._multi_adding = false;
				frm.refresh_field('items');
				const added = created_children.length;
				if (added > 0) {
					frappe.show_alert({ message: __('{0} item(s) added', [added]), indicator: 'green' });
				}
			}).catch(() => {
				frm._multi_adding = false;
				frm.refresh_field('items');
				frappe.show_alert({ message: __('Some items failed to fetch details'), indicator: 'orange' });
			});

			d.hide();
		}
	});

	const results_html = $(`
		<div style="max-height:320px;overflow:auto;">
			<table style="width:100%;border-collapse:collapse;border:1px solid #d1d8dd;">
				<thead>
					<tr style="background-color:#f5f5f5;">
						<th style="padding:8px;border:1px solid #d1d8dd;text-align:left;">Item Code</th>
						<th style="padding:8px;border:1px solid #d1d8dd;text-align:left;">Item Name</th>
						<th style="padding:8px;border:1px solid #d1d8dd;text-align:left;">Available Qty</th>
						<th style="padding:8px;border:1px solid #d1d8dd;text-align:left;width:80px;">Qty</th>
					</tr>
				</thead>
				<tbody></tbody>
			</table>
		</div>
		<div class="multi-pager" style="margin-top:8px;text-align:center;"></div>
	`);
	d.get_field('results').$wrapper.html(results_html);
	const $tbody = results_html.find('tbody');

	const search_field = d.get_field('search');
	const page_state = { page: 0 };
	search_field.df.onchange = () => {
		const txt = search_field.get_value();
		const wh = d.get_value('warehouse');
		if (!txt || !wh) return;
		page_state.page = 0;
		search_items_with_stock_for_native_po(txt, wh, $tbody, d, page_state.page);
	};

	d.show();
}

function search_items_with_stock_for_native_po(txt, warehouse, $tbody, d, page = 0) {
	$tbody.empty();
	const page_length = 10;
	const start = (page || 0) * page_length;

	frappe.call({
		method: 'frappe.desk.search.search_widget',
		args: { doctype: 'Item', txt: txt, start: start, page_length: page_length, as_dict: 1 },
		callback(r) {
			const results = r.message || r.results || [];
			const mapped = (results || []).map((row) => {
				const keys = Object.keys(row || {});
				const value = keys.length ? row[keys[0]] : '';
				const description = keys.length > 1 ? row[keys[1]] : '';
				return { value: value, description: description };
			});
			const results_mapped = mapped;
			if (!results_mapped.length) {
				$tbody.append('<tr><td colspan="4" style="padding:8px;text-align:center;color:#999;">No Items Found</td></tr>');
				render_multi_pager_po(d, page, 0);
				return;
			}

			const item_codes = results_mapped.map((x) => x.value);
			frappe.call({
				method: 'frappe.client.get_list',
				args: { doctype: 'Bin', filters: { warehouse: warehouse, item_code: ['in', item_codes] }, fields: ['item_code', 'actual_qty', 'reserved_qty'], limit_page_length: 100 },
				callback(b) {
					const bins = {};
					(b.message || []).forEach((bin) => { bins[bin.item_code] = (bin.actual_qty || 0) - (bin.reserved_qty || 0); });

					results_mapped.forEach((rw) => {
						const available = bins[rw.value] || 0;
						const tr = $(`
							<tr data-item-code="${rw.value}" style="border-bottom:1px solid #e0e0e0;">
								<td style="padding:8px;border:1px solid #d1d8dd;">${rw.value}</td>
								<td style="padding:8px;border:1px solid #d1d8dd;">${frappe.utils.escape_html(rw.description || rw.value)}</td>
								<td style="padding:8px;border:1px solid #d1d8dd;">${available.toFixed(2)}</td>
								<td style="padding:8px;border:1px solid #d1d8dd;"><input type="number" class="multi-qty" step="1" min="0" value="0" style="width:100%;padding:4px 6px;height:28px;font-size:12px;box-sizing:border-box;border:1px solid #d1d8dd;border-radius:3px;"></td>
							</tr>
						`);
						$tbody.append(tr);
					});
					render_multi_pager_po(d, page, results.length);
				}
			});
		}
	});
}

function render_multi_pager_po(d, page, results_length) {
	const $pager = $(d.body).find('.multi-pager');
	if (!$pager.length) return;
	const page_length = 10;
	$pager.empty();
	const $prev = $(`<button class="btn btn-default" style="margin-right:8px;">Prev</button>`);
	const $next = $(`<button class="btn btn-default">Next</button>`);
	if (page > 0) {
		$prev.on('click', () => {
			const txt = d.get_value('search');
			const wh = d.get_value('warehouse');
			const $tbody = d.get_field('results').$wrapper.find('tbody');
			search_items_with_stock_for_native_po(txt, wh, $tbody, d, page - 1);
		});
		$pager.append($prev);
	}
	$pager.append(`<span style="margin:0 8px;">Page ${page + 1}</span>`);
	if (results_length >= page_length) {
		$next.on('click', () => {
			const txt = d.get_value('search');
			const wh = d.get_value('warehouse');
			const $tbody = d.get_field('results').$wrapper.find('tbody');
			search_items_with_stock_for_native_po(txt, wh, $tbody, d, page + 1);
		});
		$pager.append($next);
	}
}

})();

