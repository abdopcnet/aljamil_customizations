// ============================================
// File 1: add_row.js
// ============================================
frappe.ui.form.on('Sales Order', {
	validate: function (frm) {
		// Check insurance table
		if (frm.doc.custom__insurance_data && frm.doc.custom__insurance_data.length > 1) {
			frappe.throw(__('لا يمكن إضافة أكثر من صف واحد في جدول التأمين.'));
		}
		// Check sizes table
		if (frm.doc.custom_size && frm.doc.custom_size.length > 1) {
			frappe.throw(__('لا يمكن إضافة أكثر من صف واحد في جدول المقاسات.'));
		}
	},

	custom__insurance_data_add: function (frm) {
		if (frm.doc.custom__insurance_data.length > 1) {
			// Delete extra row immediately
			frm.doc.custom__insurance_data.splice(1);
			frm.refresh_field('custom__insurance_data');
			frappe.msgprint(__('مسموح فقط بسطر واحد في جدول التأمين.'));
		}
	},

	custom_size_add: function (frm) {
		if (frm.doc.custom_size.length > 1) {
			// Delete extra row immediately
			frm.doc.custom_size.splice(1);
			frm.refresh_field('custom_size');
			frappe.msgprint(__('مسموح فقط بسطر واحد في جدول المقاسات.'));
		}
	},
});

// ============================================
// File 2: approval_amount_limit.js
// ============================================
frappe.ui.form.on('Sales Order', {
	validate: function (frm) {
		let total = 0;

		// Sum custom_approval_amount values in items table
		frm.doc.items.forEach(function (row) {
			total += row.custom_approval_amount || 0;
		});

		// Compare total with main field
		if (total > (frm.doc.custom_approval_amount || 0)) {
			frappe.throw(__('إجمالي مبلغ الموافقة في البنود يتجاوز المبلغ المحدد في أمر البيع.'));
		}
	},
});

// ============================================
// File 4: available_qty.js
// ============================================
// =======================
// Sales Order - Use projected_qty to show available qty
// projected_qty = actual_qty + ordered_qty + indented_qty + planned_qty - reserved_qty - ...
// =======================

frappe.ui.form.on('Sales Order Item', {
	item_code(frm, cdt, cdn) {
		// If custom table exists, skip native table updates
		if (frm.fields_dict.custom_items_table) {
			return; // Custom table handles updates
		}
		update_available_qty_strict(frm, cdt, cdn);
	},
	warehouse(frm, cdt, cdn) {
		// If custom table exists, skip native table updates
		if (frm.fields_dict.custom_items_table) {
			return; // Custom table handles updates
		}
		update_available_qty_strict(frm, cdt, cdn);
	},
	qty(frm, cdt, cdn) {
		// If custom table exists, skip native table updates
		if (frm.fields_dict.custom_items_table) {
			return; // Custom table handles updates
		}
		update_available_qty_strict(frm, cdt, cdn);
	},
});

frappe.ui.form.on('Sales Order', {
	refresh(frm) {
		// If custom table exists, skip native table updates
		if (frm.fields_dict.custom_items_table) {
			return; // Custom table handles updates
		}

		if (frm.doc.docstatus === 0) {
			(frm.doc.items || []).forEach((d) => {
				update_available_qty_strict(frm, d.doctype, d.name);
			});
		}
	},
	onload_post_render(frm) {
		// Subscribe to real-time warehouse stock updates
		// If custom table exists, skip native table updates
		if (frm.fields_dict.custom_items_table) {
			return; // Custom table handles updates
		}

		frappe.realtime.on('bin_update', (data) => {
			(frm.doc.items || []).forEach((d) => {
				if (d.item_code === data.item_code && d.warehouse === data.warehouse) {
					// Use projected_qty from Bin directly
					const projected_qty = data.projected_qty || 0;
					frappe.model.set_value(d.doctype, d.name, 'projected_qty', projected_qty);
					refresh_field('items');
				}
			});
		});
	},
});

// =======================
// Function to update projected_qty from Bin
// projected_qty includes: actual_qty + ordered_qty + indented_qty + planned_qty - reserved_qty - ...
// =======================
function update_available_qty_strict(frm, cdt, cdn) {
	// If custom table exists, skip native table updates
	if (frm.fields_dict.custom_items_table) {
		return; // Custom table handles updates
	}

	let row = locals[cdt][cdn];

	if (row.item_code && row.warehouse) {
		frappe.db
			.get_value(
				'Bin',
				{
					item_code: row.item_code,
					warehouse: row.warehouse,
				},
				['projected_qty'],
			)
			.then((r) => {
				if (r.message) {
					const projected_qty = r.message.projected_qty || 0;
					frappe.model.set_value(cdt, cdn, 'projected_qty', projected_qty);
					refresh_field('items');
				} else {
					frappe.model.set_value(cdt, cdn, 'projected_qty', 0);
					refresh_field('items');
				}
			});
	} else {
		frappe.model.set_value(cdt, cdn, 'projected_qty', 0);
		refresh_field('items');
	}
}

// ============================================
// File 5: contract_discount.js
// ============================================
frappe.ui.form.on('Sales Order', {
	custom_insurance_company: function (frm) {
		// Check if insurance company exists
		if (frm.doc.custom_insurance_company) {
			frappe.db
				.get_doc('Insurance Company', frm.doc.custom_insurance_company)
				.then((doc) => {
					frm.set_value('custom_contract_discount', doc.custom_contract_discount);
					// Make field read-only if there is a percentage
					if (doc.custom_contract_discount) {
						frm.set_df_property('custom_insurance_company', 'read_only', true);
					}
				})
				.catch((err) => {
					frappe.msgprint(__('لم يتم العثور على شركة التأمين المحددة'));
					console.error(err);
				});
		} else {
			frm.set_value('custom_contract_discount', null);
			// Make field editable if insurance company is not specified
			frm.set_df_property('custom_insurance_company', 'read_only', false);
		}
	},

	custom_contract_discount: function (frm) {
		// If percentage is cleared, make field editable
		if (!frm.doc.custom_contract_discount) {
			frm.set_df_property('custom_insurance_company', 'read_only', false);
		}
	},
});

// ============================================
// File 6: deductible_amount.js
// ============================================
frappe.ui.form.on('Sales Order', {
	onload(frm) {
		calculate_deductible_amount(frm);
	},
	custom_approval_amount(frm) {
		calculate_deductible_amount(frm);
	},
	custom_insurance_percentage(frm) {
		calculate_deductible_amount(frm);
	},
	custom_maximum_limit(frm) {
		calculate_deductible_amount(frm);
	},
});

function calculate_deductible_amount(frm) {
	let approval = frm.doc.custom_approval_amount || 0;
	let percentage = frm.doc.custom_insurance_percentage || 0;
	let max_limit = frm.doc.custom_maximum_limit || 0;

	let decimal_percentage = percentage / 100;
	let result = approval * decimal_percentage;

	if (max_limit > 0 && max_limit < result) {
		frm.set_value('custom_deductible_amount', max_limit);
	} else {
		frm.set_value('custom_deductible_amount', result);
	}
}

// ============================================
// File 7: delete_row.js
// ============================================
frappe.ui.form.on('Sales Order Item', {
	before_items_remove: function (frm, cdt, cdn) {
		// If custom table exists, skip native table delete handling
		if (frm.fields_dict.custom_items_table) {
			return; // Custom table handles deletion
		}

		let row = frappe.get_doc(cdt, cdn);

		if (row.custom_stock_entry) {
			frappe.confirm(
				`⚠️ تم إصدار سند تحويل لهذا الصنف - رقم السند <b>${row.custom_stock_entry}</b><br><br>
                هل أنت متأكد أنك تريد حذف هذا الصنف؟`,
				function () {
					// User confirmed -> delete row manually
					frm.doc.items = frm.doc.items.filter((r) => r.name !== row.name);
					frm.refresh_field('items');
				},
				function () {
					// User cancelled -> do nothing, row remains
					frappe.show_alert('تم إلغاء الحذف');
				},
			);

			// Stop automatic default deletion
			throw 'تم إيقاف الحذف حتى تأكيد المستخدم';
		}
	},

	// When adding new item -> copy set_warehouse value
	items_add: function (frm, cdt, cdn) {
		// If custom table exists, skip native table add handling
		if (frm.fields_dict.custom_items_table) {
			return; // Custom table handles addition
		}

		let row = frappe.get_doc(cdt, cdn);

		if (frm.doc.set_warehouse) {
			frappe.model.set_value(cdt, cdn, 'warehouse', frm.doc.set_warehouse);
		}
	},
});

frappe.ui.form.on('Sales Order', {
	// When set_warehouse changes -> update all existing items
	set_warehouse: function (frm) {
		// If custom table exists, skip native table update handling
		if (frm.fields_dict.custom_items_table) {
			return; // Custom table handles updates
		}

		(frm.doc.items || []).forEach((row) => {
			frappe.model.set_value(row.doctype, row.name, 'warehouse', frm.doc.set_warehouse);
		});
	},
});

// ============================================
// File 8: discount.js
// ============================================
frappe.ui.form.on('Sales Order', {
	onload: function (frm) {
		if (frm.doc.docstatus === 0 && frappe.user.has_role('Sales Manager')) {
			update_discount_button(frm);
		}
	},
	refresh: function (frm) {
		if (frm.doc.docstatus === 0 && frappe.user.has_role('Sales Manager')) {
			setTimeout(() => {
				update_discount_button(frm);
			}, 300);
		}
	},
	items_on_form_render: function (frm) {
		update_discount_button(frm);
	},
	items_on_change: function (frm) {
		update_discount_button(frm);
	},
	after_save: function (frm) {
		setTimeout(() => {
			update_discount_button(frm);
		}, 300);
	},
});

let discount_button = null;

function update_discount_button(frm) {
	if (!frappe.user.has_role('Sales Manager')) {
		if (discount_button) {
			discount_button.remove();
			discount_button = null;
		}
		return;
	}

	const pending_count = count_pending_discounts(frm);

	if (pending_count === 0) {
		if (discount_button) {
			discount_button.remove();
			discount_button = null;
		}
		return;
	}

	if (discount_button) {
		discount_button.remove();
	}

	discount_button = frm.add_custom_button(`👓 خصومات (${pending_count})`, function () {
		show_individual_discount_dialogs(frm);
	});
}

function count_pending_discounts(frm) {
	return (frm.doc.items || []).filter((item) => {
		if (item.custom_discount2 <= 0) return false;
		const key = get_local_key(frm.doc.name, item.name);
		const decision = localStorage.getItem(key);
		return decision !== 'approved' && decision !== 'rejected';
	}).length;
}

function show_individual_discount_dialogs(frm) {
	let rows = (frm.doc.items || []).filter((item) => {
		if (item.custom_discount2 <= 0) return false;
		const key = get_local_key(frm.doc.name, item.name);
		const decision = localStorage.getItem(key);
		return decision !== 'approved' && decision !== 'rejected';
	});

	if (rows.length === 0) {
		frappe.msgprint('✅ لا توجد خصومات بحاجة للموافقة.');
		return;
	}

	function show_next_dialog(index) {
		if (index >= rows.length) {
			frm.save().then(() => {
				frappe.msgprint('✅ تم الانتهاء من مراجعة الخصومات.');
				setTimeout(() => update_discount_button(frm), 300);
			});
			return;
		}

		const row = rows[index];
		const key = get_local_key(frm.doc.name, row.name);

		const branch = frm.doc.branch || frm.doc.custom_branch || 'غير محدد';

		const d = new frappe.ui.Dialog({
			title: `🔔 طلب خصم اضافي`,
			fields: [
				{
					fieldtype: 'HTML',
					options: `
                        <div style="margin-bottom: 15px;">
                            <b>الصنف:</b> ${row.item_code}<br>
                            <b>الخصم:</b> ${format_currency(row.custom_discount2)}<br>
                            <b>كود الخصم:</b> ${row.custom_discount_code || 'غير متوفر'}<br>
                            <b>الفرع:</b> ${branch}
                        </div>`,
				},
			],
			primary_action_label: '✅ موافق',
			primary_action: function () {
				frappe.model.set_value(row.doctype, row.name, 'custom_discount2_approved', 1);
				frappe.model.set_value(
					row.doctype,
					row.name,
					'custom__discount_code_approved',
					row.custom_discount_code || '',
				);
				localStorage.setItem(key, 'approved');
				d.hide();
				update_discount_button(frm);
				show_next_dialog(index + 1);
			},
			secondary_action_label: '❌ غير موافق',
			secondary_action: function () {
				localStorage.setItem(key, 'rejected');
				d.hide();
				update_discount_button(frm);
				show_next_dialog(index + 1);
			},
		});

		d.show();
	}

	show_next_dialog(0);
}

function get_local_key(order_name, item_name) {
	return `discount_decision_${order_name}_${item_name}`;
}

frappe.ui.form.on('Sales Order', {
	before_submit(frm) {
		let errors = [];

		frm.doc.items.forEach((row) => {
			if ((row.custom_discount_code || '') !== (row.custom__discount_code_approved || '')) {
				errors.push(`🚫 الصف ${row.idx}: كود الخصم غير موجود.`);
			}
		});

		if (errors.length > 0) {
			frappe.throw({
				title: 'اكتب كود الخصم',
				message: errors.join('<br>'),
			});
		}
	},
});

frappe.ui.form.on('Sales Order', {
	onload(frm) {
		frm.doc.items.forEach((row) => {
			if (!row._original_custom_discount2 && row.custom_discount2 > 0) {
				row._original_custom_discount2 = row.custom_discount2;
			}
		});
	},

	after_save(frm) {
		let updated = false;

		frm.doc.items.forEach((row) => {
			if (!row._original_custom_discount2 && row.custom_discount2 > 0) {
				row._original_custom_discount2 = row.custom_discount2;

				if (!row.custom_discount_code) {
					row.custom_discount_code = generateRandomCode(10);
				}

				updated = true;
			}
		});

		if (updated) frm.save();
	},

	validate(frm) {
		frm.doc.items.forEach((row) => {
			if (!row._original_custom_discount2 && row.custom_discount2 > 0) {
				row._original_custom_discount2 = row.custom_discount2;

				if (!row.custom_discount_code) {
					row.custom_discount_code = generateRandomCode(10);
				}
			}
		});
	},

	refresh(frm) {
		// Do not check code or approval
	},

	before_submit(frm) {
		// Do not check code or approval
	},
});

frappe.ui.form.on('Sales Order Item', {
	custom_discount2(frm, cdt, cdn) {
		let row = locals[cdt][cdn];

		const original = Number(row._original_custom_discount2) || 0;
		const current = Number(row.custom_discount2) || 0;

		if (!row._original_custom_discount2 && current > 0) {
			frappe.model.set_value(cdt, cdn, '_original_custom_discount2', current);

			if (!row.custom_discount_code) {
				const code = generateRandomCode(10);
				frappe.model.set_value(cdt, cdn, 'custom_discount_code', code);
			}

			return;
		}

		if (row._original_custom_discount2 && current !== original) {
			frappe.msgprint(__('🚫 لا يمكنك تعديل الخصم بعد إدخاله. تم إرجاع القيمة الأصلية.'));
			frappe.model.set_value(cdt, cdn, 'custom_discount2', row._original_custom_discount2);
		}
	},

	custom_discount_code_approved(frm, cdt, cdn) {
		// Nothing here either
	},

	items_add(frm, cdt, cdn) {
		frappe.model.set_value(cdt, cdn, '_original_custom_discount2', null);
		frappe.model.set_value(cdt, cdn, 'custom_discount_code', null);
		frappe.model.set_value(cdt, cdn, 'custom_discount_code_approved', null);
	},
});

// Generate random code only
function generateRandomCode(length) {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	let result = '';
	for (let i = 0; i < length; i++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return result;
}

frappe.ui.form.on('Sales Order Item', {
	custom_discount: update_discount_simple,
	custom_discount2: update_discount_simple,
	custom_discount_percentage: update_discount_simple,
	price_list_rate: update_discount_simple,
});

// Function from discount.js - Simple discount calculation (without dividing by qty)
function update_discount_simple(frm, cdt, cdn) {
	let row = locals[cdt][cdn];

	// Calculate discount percentage from price
	let base_discount = 0;
	if (row.price_list_rate && row.custom_discount_percentage) {
		base_discount = (row.price_list_rate * row.custom_discount_percentage) / 100;
	}

	// Sum discounts only and write result
	let total_discount = (row.custom_discount || 0) + (row.custom_discount2 || 0) + base_discount;

	// Write result to field, as if user wrote it manually
	frappe.model.set_value(cdt, cdn, 'discount_amount', total_discount);
}

// =======================
// ✅ Sales Order
// =======================
frappe.ui.form.on('Sales Order', {
	onload(frm) {
		frm._discount_msg_shown = frm._no_item_code_msg = false;
		frm._original_custom__discount_percentage = frm.doc.custom__discount_percentage || 0;
		(frm.doc.items || []).forEach(
			(r) => (r._original_custom_discount_percentage = r.custom_discount_percentage || 0),
		);
	},

	validate(frm) {
		return check_main_discount(frm).then(() => {
			const promises = (frm.doc.items || []).map((r) => {
				if (r.item_code && frm.doc.selling_price_list) {
					return get_item_max_discount(r.item_code, frm.doc.selling_price_list).then(
						(max_disc) => {
							return get_allowed_discount_limit(max_disc).then((allowed) => {
								if ((+r.custom_discount_percentage || 0) > allowed) {
									r.custom_discount_percentage =
										r._original_custom_discount_percentage || 0;
									frappe.throw(
										__(
											'🚫 نسبة الخصم (custom_discount_percentage) لا يمكن أن تتجاوز الحد ({0}%)',
											[allowed],
										),
									);
								}
							});
						},
					);
				}
				return Promise.resolve();
			});
			return Promise.all(promises);
		});
	},

	after_save(frm) {
		frm._original_custom__discount_percentage = frm.doc.custom__discount_percentage || 0;
		(frm.doc.items || []).forEach(
			(r) => (r._original_custom_discount_percentage = r.custom_discount_percentage || 0),
		);
	},

	custom__discount_percentage(frm) {
		sync_main_discount(frm);
	},
});

frappe.ui.form.on('Sales Order Item', {
	item_code(frm, cdt, cdn) {
		const row = locals[cdt][cdn];
		// When selecting item code, copy value from main field if exists and visible
		if (
			!frm.get_field('custom__discount_percentage').df.hidden &&
			frm.doc.custom__discount_percentage > 0
		) {
			frappe.model.set_value(
				cdt,
				cdn,
				'custom_discount_percentage',
				frm.doc.custom__discount_percentage,
			);
			row._original_custom_discount_percentage = frm.doc.custom__discount_percentage;
		}
	},
});

// =======================
// 🔧 Helper Functions
// =======================
function sync_main_discount(frm) {
	// ✅ If field is hidden → use employee limit directly
	if (frm.get_field('custom__discount_percentage').df.hidden) {
		return get_allowed_discount_limit().then((allowed) => {
			frm._original_custom__discount_percentage = allowed;
			(frm.doc.items || []).forEach((row) => {
				frappe.model.set_value(
					row.doctype,
					row.name,
					'custom_discount_percentage',
					allowed,
				);
				row._original_custom_discount_percentage = allowed;
			});
		});
	}

	const entered = +frm.doc.custom__discount_percentage || 0;
	return get_allowed_discount_limit().then((allowed) => {
		if (entered > allowed) {
			frappe.msgprint(
				__('🚫 نسبة الخصم (الرئيسية) لا يمكن أن تتجاوز الحد ({0}%)', [allowed]),
			);
			frm.set_value(
				'custom__discount_percentage',
				frm._original_custom__discount_percentage || 0,
			);
			return;
		}
		frm._original_custom__discount_percentage = entered;
		(frm.doc.items || []).forEach((row) => {
			frappe.model.set_value(row.doctype, row.name, 'custom_discount_percentage', entered);
			row._original_custom_discount_percentage = entered;
		});
	});
}

function validate_discount_field(frm, cdt, cdn) {
	const row = locals[cdt][cdn];
	if (!row.item_code) {
		frappe.model.set_value(cdt, cdn, 'custom_discount_percentage', 0);
		return;
	}
	const entered = +row.custom_discount_percentage || 0;
	frappe.db
		.get_value(
			'Item Price',
			{ item_code: row.item_code, price_list: frm.doc.selling_price_list },
			'custom_discount_percent',
		)
		.then((r) =>
			get_allowed_discount_limit(+r.message?.custom_discount_percent || 0).then(
				(allowed) => {
					if (entered > allowed) {
						frappe.model.set_value(
							cdt,
							cdn,
							'custom_discount_percentage',
							row._original_custom_discount_percentage || 0,
						);
						// Message is shown in the main custom_discount_percentage handler to avoid duplication
					} else {
						row._original_custom_discount_percentage = entered;
					}
				},
			),
		);
}

function get_item_max_discount(item_code, price_list) {
	return frappe.db
		.get_value('Item Price', { item_code, price_list }, 'custom_discount_percent')
		.then((r) => +r.message?.custom_discount_percent || 0);
}

function get_allowed_discount_limit(max_discount = 0) {
	return frappe
		.call({
			method: 'frappe.client.get_list',
			args: {
				doctype: 'Employee',
				filters: { user_id: frappe.session.user, status: 'Active' },
				fields: ['custom_discount_percentage_limit'],
				limit_page_length: 1,
			},
		})
		.then((res) =>
			Math.max(max_discount, +res.message?.[0]?.custom_discount_percentage_limit || 0),
		);
}

function check_main_discount(frm) {
	// ✅ If field is hidden → use limit directly
	if (frm.get_field('custom__discount_percentage').df.hidden) {
		return get_allowed_discount_limit().then((allowed) => {
			frm._original_custom__discount_percentage = allowed;
		});
	}

	const entered = +frm.doc.custom__discount_percentage || 0;
	return get_allowed_discount_limit().then((allowed) => {
		if (entered > allowed) {
			frappe.throw(__('🚫 نسبة الخصم (الرئيسية) لا يمكن أن تتجاوز الحد ({0}%)', [allowed]));
		} else {
			frm._original_custom__discount_percentage = entered;
		}
	});
}

// =======================
// ✅ Sales Order
// =======================
frappe.ui.form.on('Sales Order', {
	onload(frm) {
		frm._discount_msg_shown = false;
		frm._no_item_code_msg = false;

		frm.doc.items.forEach((row) => {
			if (!row._original_custom_discount_percentage && row.custom_discount_percentage > 0) {
				row._original_custom_discount_percentage = row.custom_discount_percentage;
			}
		});
	},

	async validate(frm) {
		frm._validate_discount_msg_shown = false;

		for (const row of frm.doc.items) {
			if (row.custom_discount_percentage > 0) {
				const original = Number(row._original_custom_discount_percentage) || 0;
				const current = Number(row.custom_discount_percentage) || 0;

				if (!row._original_custom_discount_percentage) {
					row._original_custom_discount_percentage = current;
				}
			}

			if (row.item_code && frm.doc.selling_price_list) {
				const price = await frappe.db.get_value(
					'Item Price',
					{
						item_code: row.item_code,
						price_list: frm.doc.selling_price_list,
					},
					'custom_discount_percent',
				);

				const max_discount = Number(price.message?.custom_discount_percent) || 0;
				console.log('🔍 [Discount Debug - VALIDATE] Item Price discount:', {
					item_code: row.item_code,
					price_list: frm.doc.selling_price_list,
					max_discount_from_item_price: max_discount,
					item_price_data: price.message,
				});

				// Get Employee from Sales Person instead of user_id
				let employee_limit = 0;
				if (frm.doc.custom_sales_person) {
					console.log('🔍 [Discount Debug - VALIDATE] Sales Person found:', {
						custom_sales_person: frm.doc.custom_sales_person,
					});
					const sales_person = await frappe.db.get_value(
						'Sales Person',
						frm.doc.custom_sales_person,
						'employee',
					);
					console.log('🔍 [Discount Debug - VALIDATE] Sales Person data:', {
						sales_person_name: frm.doc.custom_sales_person,
						employee_from_sales_person: sales_person.message?.employee,
						sales_person_data: sales_person.message,
					});
					if (sales_person.message?.employee) {
						const employee = await frappe.db.get_value(
							'Employee',
							sales_person.message.employee,
							'custom_discount_percentage_limit',
						);
						employee_limit =
							Number(employee.message?.custom_discount_percentage_limit) || 0;
						console.log('🔍 [Discount Debug - VALIDATE] Employee from Sales Person:', {
							employee_limit: employee_limit,
							employee_data: employee.message,
						});
					}
				}

				// Fallback to user's employee if no sales person
				if (!employee_limit) {
					console.log('🔍 [Discount Debug - VALIDATE] Using fallback (user employee):', {
						user: frappe.session.user,
						reason: 'No employee limit from Sales Person',
					});
					const res = await frappe.call({
						method: 'frappe.client.get_list',
						args: {
							doctype: 'Employee',
							filters: {
								user_id: frappe.session.user,
								status: 'Active',
							},
							fields: ['custom_discount_percentage_limit'],
							limit_page_length: 1,
						},
					});
					employee_limit =
						Number(res.message?.[0]?.custom_discount_percentage_limit) || 0;
					console.log('🔍 [Discount Debug - VALIDATE] Fallback employee data:', {
						employee_limit: employee_limit,
						employee_data: res.message?.[0],
					});
				} else {
					console.log(
						'🔍 [Discount Debug - VALIDATE] Using Sales Person employee limit',
					);
				}

				const allowed_limit = Math.max(max_discount, employee_limit);
				const entered = Number(row.custom_discount_percentage) || 0;

				console.log('🔍 [Discount Debug - VALIDATE] Final calculation:', {
					max_discount_from_item_price: max_discount,
					employee_limit: employee_limit,
					allowed_limit: allowed_limit,
					entered_discount: entered,
					calculation: `Math.max(${max_discount}, ${employee_limit}) = ${allowed_limit}`,
				});

				if (entered > allowed_limit) {
					let rollback_to = Number(row._original_custom_discount_percentage) || 0;

					// Restore original value
					row.custom_discount_percentage = rollback_to;

					// Prevent save
					throw frappe.throw({
						title: __('خصم غير مسموح'),
						message: __('🚫 نسبة الخصم لا يمكن أن تتجاوز الحد ({0}%)', [
							allowed_limit,
						]),
						indicator: 'red',
					});
				}
			}
		}
	},

	after_save(frm) {
		let updated = false;
		frm.doc.items.forEach((row) => {
			if (!row._original_custom_discount_percentage && row.custom_discount_percentage > 0) {
				row._original_custom_discount_percentage = row.custom_discount_percentage;
				updated = true;
			}
		});
		if (updated) frm.save();
	},
});

// =======================
// ✅ Sales Order Item
// =======================
frappe.ui.form.on('Sales Order Item', {
	custom_discount_percentage(frm, cdt, cdn) {
		const row = locals[cdt][cdn];

		if (!row.item_code) {
			frappe.model.set_value(cdt, cdn, 'custom_discount_percentage', 0);

			if (!frm._no_item_code_msg) {
				frm._no_item_code_msg = true;
				frappe.msgprint(__('🚫 يجب تحديد الصنف أولًا قبل إدخال نسبة الخصم'));
			}

			return;
		}

		if (!frm.doc.selling_price_list) return;

		const entered = Number(row.custom_discount_percentage) || 0;

		frappe.db
			.get_value(
				'Item Price',
				{
					item_code: row.item_code,
					price_list: frm.doc.selling_price_list,
				},
				'custom_discount_percent',
			)
			.then((r) => {
				const max_discount = Number(r.message?.custom_discount_percent) || 0;
				console.log('🔍 [Discount Debug] Item Price discount:', {
					item_code: row.item_code,
					price_list: frm.doc.selling_price_list,
					max_discount_from_item_price: max_discount,
					item_price_data: r.message,
				});

				// Helper function to process discount validation
				function processDiscountValidation(max_discount, employee_limit) {
					const allowed_limit = Math.max(max_discount, employee_limit);
					const entered = Number(row.custom_discount_percentage) || 0;

					console.log('🔍 [Discount Debug] Final calculation:', {
						max_discount_from_item_price: max_discount,
						employee_limit: employee_limit,
						allowed_limit: allowed_limit,
						entered_discount: entered,
						calculation: `Math.max(${max_discount}, ${employee_limit}) = ${allowed_limit}`,
					});

					if (entered > allowed_limit) {
						const rollback_to = Number(row._original_custom_discount_percentage) || 0;

						frappe.model.set_value(
							cdt,
							cdn,
							'custom_discount_percentage',
							rollback_to,
						);

						if (!frm._discount_msg_shown) {
							frm._discount_msg_shown = true;
							frappe.msgprint({
								title: __('خصم غير مسموح'),
								message: __('🚫 نسبة الخصم لا يمكن أن تتجاوز الحد ({0}%)', [
									allowed_limit,
								]),
								indicator: 'red',
							});
						}
					} else {
						// Save original value
						frappe.model.set_value(
							cdt,
							cdn,
							'_original_custom_discount_percentage',
							entered,
						);
						frm._discount_msg_shown = false;
						frm._no_item_code_msg = false;
					}
				}

				// Get Employee from Sales Person instead of user_id
				if (frm.doc.custom_sales_person) {
					console.log('🔍 [Discount Debug] Sales Person found:', {
						custom_sales_person: frm.doc.custom_sales_person,
					});
					// First get employee from Sales Person
					frappe.db
						.get_value('Sales Person', frm.doc.custom_sales_person, 'employee')
						.then((sales_person) => {
							console.log('🔍 [Discount Debug] Sales Person data:', {
								sales_person_name: frm.doc.custom_sales_person,
								employee_from_sales_person: sales_person.message?.employee,
								sales_person_data: sales_person.message,
							});
							if (sales_person.message?.employee) {
								return frappe.db.get_value(
									'Employee',
									sales_person.message.employee,
									'custom_discount_percentage_limit',
								);
							}
							return null;
						})
						.then((employee) => {
							let employee_limit = 0;
							if (employee && employee.message?.custom_discount_percentage_limit) {
								employee_limit =
									Number(employee.message.custom_discount_percentage_limit) || 0;
							}
							console.log('🔍 [Discount Debug] Employee from Sales Person:', {
								employee_limit: employee_limit,
								employee_data: employee?.message,
							});

							// Fallback to user's employee if no sales person or no limit
							if (!employee_limit) {
								console.log(
									'🔍 [Discount Debug] Using fallback (user employee):',
									{
										user: frappe.session.user,
										reason: 'No employee limit from Sales Person',
									},
								);
								frappe.call({
									method: 'frappe.client.get_list',
									args: {
										doctype: 'Employee',
										filters: {
											user_id: frappe.session.user,
											status: 'Active',
										},
										fields: ['custom_discount_percentage_limit'],
										limit_page_length: 1,
									},
									callback(res) {
										const fallback_limit =
											Number(
												res.message?.[0]?.custom_discount_percentage_limit,
											) || 0;
										console.log(
											'🔍 [Discount Debug] Fallback employee data:',
											{
												fallback_limit: fallback_limit,
												employee_data: res.message?.[0],
											},
										);
										processDiscountValidation(
											max_discount,
											fallback_limit || employee_limit,
										);
									},
								});
							} else {
								console.log(
									'🔍 [Discount Debug] Using Sales Person employee limit',
								);
								processDiscountValidation(max_discount, employee_limit);
							}
						});
				} else {
					// No sales person, use user's employee
					console.log('🔍 [Discount Debug] No Sales Person, using user employee:', {
						user: frappe.session.user,
					});
					frappe.call({
						method: 'frappe.client.get_list',
						args: {
							doctype: 'Employee',
							filters: {
								user_id: frappe.session.user,
								status: 'Active',
							},
							fields: ['custom_discount_percentage_limit'],
							limit_page_length: 1,
						},
						callback(res) {
							const employee_limit =
								Number(res.message?.[0]?.custom_discount_percentage_limit) || 0;
							console.log('🔍 [Discount Debug] User employee data:', {
								employee_limit: employee_limit,
								employee_data: res.message?.[0],
							});
							processDiscountValidation(max_discount, employee_limit);
						},
					});
				}
			});
	},

	items_add(frm, cdt, cdn) {
		frappe.model.set_value(cdt, cdn, '_original_custom_discount_percentage', null);
	},
});

frappe.ui.form.on('Sales Order', {
	before_load: function (frm) {
		frm.employee = null;
		frm.custom_sales_limit = 0;
		frm._shown_employee_error = false; // Reset flag on each load
	},

	onload: async function (frm) {
		try {
			const { message: employees } = await frappe.call({
				method: 'frappe.client.get_list',
				args: {
					doctype: 'Employee',
					filters: {
						user_id: frappe.session.user,
						status: 'Active',
					},
					fields: ['custom_sales_limit'],
				},
			});

			frm.employee = employees[0] || null;
			frm.custom_sales_limit = frm.employee?.custom_sales_limit || 0;
		} catch (error) {
			console.error('خطأ في تحميل بيانات الموظف:', error);
			frm.employee = null;
			frm.custom_sales_limit = 0;
		}
	},

	refresh: function (frm) {
		frm.doc.items.forEach((row) => {
			if (typeof row._original_custom_discount === 'undefined') {
				row._original_custom_discount = row.custom_discount;
			}
		});

		if (!frm.employee) {
			// Use set_df_property to set read_only for child table field
			// Parameters: fieldname, property, value, docname (child doctype), table_field, table_row_name
			try {
				frm.set_df_property(
					'items',
					'read_only',
					1,
					'Sales Order Item',
					'custom_discount',
				);
			} catch (e) {
				// Field might not be loaded yet, ignore error silently
			}
		} else {
			// Make field editable if employee exists
			try {
				frm.set_df_property(
					'items',
					'read_only',
					0,
					'Sales Order Item',
					'custom_discount',
				);
			} catch (e) {
				// Field might not be loaded yet, ignore error silently
			}
		}
	},
});

frappe.ui.form.on('Sales Order Item', {
	custom_discount: function (frm, cdt, cdn) {
		const row = locals[cdt][cdn];

		// No active employee: prevent editing and revert value immediately
		if (!frm.employee) {
			if (!frm._shown_employee_error) {
				frm._shown_employee_error = true;
				frappe.msgprint({
					title: 'خطأ',
					message: 'لا يمكنك تعديل الخصم - غير مرتبط بموظف نشط',
					indicator: 'red',
				});
			}

			frappe.model.set_value(
				cdt,
				cdn,
				'custom_discount',
				row._original_custom_discount || 0,
			);
			return false;
		}

		// Exceeded allowed limit
		if (row.custom_discount > frm.custom_sales_limit) {
			frappe.msgprint({
				title: 'خطأ',
				message: `تجاوز الحد المسموح (${frm.custom_sales_limit} ريال)`,
				indicator: 'red',
			});

			frappe.model.set_value(
				cdt,
				cdn,
				'custom_discount',
				row._original_custom_discount || 0,
			);
			return false;
		}

		// Update original value when edit is valid
		row._original_custom_discount = row.custom_discount;
	},

	items_add: function (frm, cdt, cdn) {
		const row = locals[cdt][cdn];
		row._original_custom_discount = row.custom_discount || 0;
	},
});

frappe.ui.form.on('Sales Order', {
	before_load: function (frm) {
		frm.employee = null;
		frm.custom_sales_limit = 0;
		frm._is_updating_discount = false;
		frm._last_valid_discount = 0;
		frm._deleting_row = false; // Flag to track delete operation
	},

	onload: async function (frm) {
		try {
			const { message: employees } = await frappe.call({
				method: 'frappe.client.get_list',
				args: {
					doctype: 'Employee',
					filters: {
						user_id: frappe.session.user,
						status: 'Active',
					},
					fields: ['custom_sales_limit'],
				},
			});

			frm.employee = employees[0] || null;
			frm.custom_sales_limit = frm.employee?.custom_sales_limit || 0;
		} catch (error) {
			console.error('خطأ في تحميل بيانات الموظف:', error);
			frm.employee = null;
			frm.custom_sales_limit = 0;
		}
	},

	refresh: function (frm) {
		frm.doc.items.forEach((row) => {
			if (typeof row._original_custom_discount === 'undefined') {
				row._original_custom_discount = row.custom_discount;
			}
		});

		// Add event for deletion to handle row deletion
		frm.get_field('items').grid.wrapper.on('row-removed', function () {
			if (!frm._deleting_row) {
				frm._deleting_row = true;
				setTimeout(() => {
					const total_discount = frm.doc.custom_discount_amount_emp || 0;
					distribute_discount(frm, total_discount);
					frm._deleting_row = false;
				}, 100);
			}
		});
	},

	custom_discount_amount_emp: function (frm) {
		if (frm._is_updating_discount || frm._deleting_row) return;

		let total_discount = frm.doc.custom_discount_amount_emp || 0;

		// If empty or zero -> reset all discounts in table to zero
		if (!total_discount || total_discount === 0) {
			// If custom table exists, skip native table updates
			if (frm.fields_dict.custom_items_table) {
				// In custom table, updates happen directly on fields
				// No need for refresh_field as custom table syncs only on save
				return;
			}

			frm.doc.items.forEach((row) => {
				frappe.model.set_value(row.doctype, row.name, 'custom_discount', 0);
				row._original_custom_discount = 0;
			});
			frm.refresh_field('items');
			return;
		}

		if (!frm.employee) {
			showEmployeeError();
			rollback_discount(frm);
			return;
		}

		if (total_discount > frm.custom_sales_limit) {
			showLimitError(frm.custom_sales_limit);
			rollback_discount(frm);
			return;
		}

		frm._last_valid_discount = total_discount;

		// Distribute discount across rows
		distribute_discount(frm, total_discount);
	},

	// Add event to validate after row removal
	after_item_remove: function (frm) {
		const total_discount = frm.doc.custom_discount_amount_emp || 0;
		distribute_discount(frm, total_discount);
	},
});

frappe.ui.form.on('Sales Order Item', {
	item_code: function (frm, cdt, cdn) {
		let total_discount = frm.doc.custom_discount_amount_emp || 0;

		if (!total_discount || total_discount === 0) {
			// If zero -> no distribution, reset to zero
			frappe.model.set_value(cdt, cdn, 'custom_discount', 0);
			return;
		}

		if (total_discount > 0) {
			distribute_discount(frm, total_discount);
		}
	},

	custom_discount: function (frm, cdt, cdn) {
		const row = locals[cdt][cdn];
		validate_row_discount(frm, row, cdt, cdn);
		validate_total_discount(frm);
	},

	// Add event when row is deleted
	items_remove: function (frm, cdt, cdn) {
		const total_discount = frm.doc.custom_discount_amount_emp || 0;
		distribute_discount(frm, total_discount);
	},
});

// ----------------------------------------
// Updated helper functions
// ----------------------------------------

function distribute_discount(frm, total_discount) {
	const item_count = frm.doc.items.length;

	if (item_count === 0 && total_discount > 0) {
		// If no items but discount exists, reset discount to zero
		frm._is_updating_discount = true;
		frm.set_value('custom_discount_amount_emp', 0);
		setTimeout(() => (frm._is_updating_discount = false), 100);
		return;
	}

	if (item_count > 0) {
		const discount_per_row = total_discount / item_count;
		frm.doc.items.forEach((row) => {
			apply_discount_to_row(frm, row, discount_per_row);
		});
	}

	// If custom table exists, don't use refresh_field as updates happen directly
	if (!frm.fields_dict.custom_items_table) {
		frm.refresh_field('items');
	}
	validate_total_discount(frm);
}

function apply_discount_to_row(frm, row, discount_value) {
	if (!frm.employee) {
		showEmployeeError();
		frappe.model.set_value(row.doctype, row.name, 'custom_discount', 0);
		return;
	}

	if (discount_value > frm.custom_sales_limit) {
		showLimitError(frm.custom_sales_limit);
		frappe.model.set_value(row.doctype, row.name, 'custom_discount', 0);
		return;
	}

	frappe.model.set_value(row.doctype, row.name, 'custom_discount', discount_value);
	row._original_custom_discount = discount_value;
}

function validate_row_discount(frm, row, cdt, cdn) {
	if (!frm.employee) {
		showEmployeeError();
		frappe.model.set_value(cdt, cdn, 'custom_discount', 0);
		return false;
	}

	if (row.custom_discount > frm.custom_sales_limit) {
		showLimitError(frm.custom_sales_limit);
		frappe.model.set_value(cdt, cdn, 'custom_discount', 0);
		return false;
	}

	row._original_custom_discount = row.custom_discount;
	return true;
}

function validate_total_discount(frm) {
	let max_allowed = frm.doc.custom_discount_amount_emp || 0;

	if (!max_allowed || max_allowed === 0) {
		max_allowed = frm.custom_sales_limit || 0;
	}

	let total_row_discount = frm.doc.items.reduce(
		(sum, row) => sum + (row.custom_discount || 0),
		0,
	);
	total_row_discount = Math.round(total_row_discount * 100) / 100; // Avoid floating point errors

	if (total_row_discount > max_allowed) {
		showTotalError(max_allowed);
		distribute_discount(frm, max_allowed);
	}
}

function rollback_discount(frm) {
	frm._is_updating_discount = true;
	frm.set_value('custom_discount_amount_emp', frm._last_valid_discount || 0);
	setTimeout(() => (frm._is_updating_discount = false), 100);
}

// ----------------------------------------
// Error messages
// ----------------------------------------

function showEmployeeError() {
	frappe.msgprint({
		title: 'خطأ',
		message: 'لا يمكنك تعديل الخصم - غير مرتبط بموظف نشط',
		indicator: 'red',
	});
}

function showLimitError(limit) {
	frappe.msgprint({
		title: 'خطأ',
		message: `قيمة الخصم تتجاوز الحد المسموح (${limit} ريال)`,
		indicator: 'red',
	});
}

function showTotalError(max_allowed) {
	frappe.msgprint({
		title: 'خطأ',
		message: `إجمالي الخصم الموزع لا يمكن أن يتجاوز (${max_allowed})`,
		indicator: 'red',
	});
}

// ============================================
// File 9: from_so_table_to_inv_table.js
// ============================================
frappe.ui.form.on('Sales Order', {
	refresh(frm) {
		if (frm.doc.docstatus === 1) {
			const watch = setInterval(() => {
				const route = frappe.get_route();

				if (route[0] === 'Form' && route[1] === 'Sales Invoice') {
					clearInterval(watch);

					frappe.model.with_doc('Sales Invoice', route[2], () => {
						const si = frappe.model.get_doc('Sales Invoice', route[2]);

						// --------- Items Table ---------
						if (si.items && si.items.length && frm.doc.items && frm.doc.items.length) {
							si.items.forEach((item, idx) => {
								const so_item = frm.doc.items[idx];
								if (so_item) {
									// Discount fields
									frappe.model.set_value(
										item.doctype,
										item.name,
										'custom_discount',
										so_item.custom_discount || '',
									);
									frappe.model.set_value(
										item.doctype,
										item.name,
										'custom_discount2',
										so_item.custom_discount2 || '',
									);
									frappe.model.set_value(
										item.doctype,
										item.name,
										'custom_discount_percentage',
										so_item.custom_discount_percentage || '',
									);

									// Lens and size fields
									frappe.model.set_value(
										item.doctype,
										item.name,
										'custom_lensmaterial',
										so_item.custom_lensmaterial || '',
									);
									frappe.model.set_value(
										item.doctype,
										item.name,
										'custom_lenscolor',
										so_item.custom_lenscolor || '',
									);
									frappe.model.set_value(
										item.doctype,
										item.name,
										'custom_lenscolorclip',
										so_item.custom_lenscolorclip || '',
									);
									frappe.model.set_value(
										item.doctype,
										item.name,
										'custom_lensfeature',
										so_item.custom_lensfeature || '',
									);
									frappe.model.set_value(
										item.doctype,
										item.name,
										'custom_polarized',
										so_item.custom_polarized || '',
									);
									frappe.model.set_value(
										item.doctype,
										item.name,
										'custom_mirror',
										so_item.custom_mirror || '',
									);
									frappe.model.set_value(
										item.doctype,
										item.name,
										'custom_templelengthsize',
										so_item.custom_templelengthsize || '',
									);
									frappe.model.set_value(
										item.doctype,
										item.name,
										'custom_lenswidthsize',
										so_item.custom_lenswidthsize || '',
									);
									frappe.model.set_value(
										item.doctype,
										item.name,
										'custom_lensheightsize',
										so_item.custom_lensheightsize || '',
									);
									frappe.model.set_value(
										item.doctype,
										item.name,
										'custom_bridgewidthsize',
										so_item.custom_bridgewidthsize || '',
									);
									frappe.model.set_value(
										item.doctype,
										item.name,
										'custom_shapesize',
										so_item.custom_shapesize || '',
									);
								}
							});
						}

						// --------- Custom Insurance Data Table ---------
						if (
							si.custom_insurance_data &&
							si.custom_insurance_data.length &&
							frm.doc.custom_insurance_data &&
							frm.doc.custom_insurance_data.length
						) {
							si.custom_insurance_data.forEach((ins_item, idx) => {
								const so_ins = frm.doc.custom_insurance_data[idx];
								if (so_ins) {
									frappe.model.set_value(
										ins_item.doctype,
										ins_item.name,
										'patients_insurance_company_name',
										so_ins.patients_insurance_company_name || '',
									);
									frappe.model.set_value(
										ins_item.doctype,
										ins_item.name,
										'policy_number',
										so_ins.policy_number || '',
									);
									frappe.model.set_value(
										ins_item.doctype,
										ins_item.name,
										'patient_name',
										so_ins.patient_name || '',
									);
									frappe.model.set_value(
										ins_item.doctype,
										ins_item.name,
										'id_number',
										so_ins.id_number || '',
									);
									frappe.model.set_value(
										ins_item.doctype,
										ins_item.name,
										'category',
										so_ins.category || '',
									);
									frappe.model.set_value(
										ins_item.doctype,
										ins_item.name,
										'expiry_date',
										so_ins.expiry_date || '',
									);
									frappe.model.set_value(
										ins_item.doctype,
										ins_item.name,
										'category_name',
										so_ins.category_name || '',
									);
									frappe.model.set_value(
										ins_item.doctype,
										ins_item.name,
										'category_type',
										so_ins.category_type || '',
									);
									frappe.model.set_value(
										ins_item.doctype,
										ins_item.name,
										'membership_number',
										so_ins.membership_number || '',
									);
									frappe.model.set_value(
										ins_item.doctype,
										ins_item.name,
										'nationality',
										so_ins.nationality || '',
									);
									frappe.model.set_value(
										ins_item.doctype,
										ins_item.name,
										'age',
										so_ins.age || '',
									);
									frappe.model.set_value(
										ins_item.doctype,
										ins_item.name,
										'file_number',
										so_ins.file_number || '',
									);
								}
							});
						}
					});
				} else {
					clearInterval(watch);
				}
			}, 200);
		}
	},
});

// ============================================
// File 10: from_so_to_inv.js
// ============================================
frappe.ui.form.on('Sales Order', {
	refresh(frm) {
		if (frm.doc.docstatus === 1) {
			const watch = setInterval(() => {
				const route = frappe.get_route();

				if (route[0] === 'Form' && route[1] === 'Sales Invoice') {
					clearInterval(watch);

					frappe.model.set_value(
						'Sales Invoice',
						route[2],
						'custom_order_type',
						frm.doc.order_type,
					);
				}
			}, 200);
		}
	},
});

// ============================================
// File 11: insurance_data.js
// ============================================
// ========================= إعدادات عامة =========================

const CUSTOMER_INSURANCE_CHILD_FIELD = 'insurance_data';
const ORDER_INSURANCE_CHILD_FIELD = 'custom_insurance_data';

// الحقول التي سيتم التعامل معها
const INSURANCE_FIELDNAMES = {
	// الحقول القديمة
	company: 'patients_insurance_company_name',
	policy_no: 'policy_number',
	patient_name: 'patient_name',
	id_no: 'id_number',
	gender: 'gender',
	marital_status: 'marital_status',
	berth_date: 'berth_date',
	religion: 'religion',
	current_job: 'current_job',
	category: 'category',
	expiry: 'expiry_date',
	cat_name: 'category_name',
	cat_type: 'category_type',
	mem_no: 'membership_number',
	nationality: 'nationality',
	age: 'age',
	file_no: 'file_number',

	// الحقول الجديدة (Custom)
	// تم التأكد من الأسماء بناءً على الصور المرفقة:
	custom_insurance_company: 'custom_insurance_company', // Link (to Supplier usually)
	custom_contract_discount: 'custom_contract_discount', // Date (from screenshot!) Wait, user said "Contract Discount".
	// Screenshot shows "Contract Discount" label, fieldname "custom_contract_discount", Type "Date".
	// This is unexpected for a "Discount", but I must follow the system.
	custom_approval_number: 'custom_approval_number',
	custom_approval_date: 'custom_approval_date',
	custom_approval_amount: 'custom_approval_amount', // Currency
	custom_insurance_percentage: 'custom_insurance_percentage', // Percent
	custom_maximum_limit: 'custom_maximum_limit', // Currency
};

// ========================= منطق الزرار =========================

frappe.ui.form.on('Sales Order', {
	refresh(frm) {
		if (frm.page.insurance_btn && !frm.page.insurance_btn.is_destroyed) {
			frm.page.insurance_btn.remove();
		}
		frm.page.insurance_btn = frm.page
			.add_inner_button(__('بيانات التأمين (Insurance Data)'), function () {
				// 1. التحقق من نوع الأمر
				const type = frm.doc.order_type || frm.doc.custom_order_type;
				if (type !== 'Insurance') {
					frappe.msgprint({
						title: __('خطأ في نوع الأمر'),
						message: __('عفوا نوع امر البيع غير صحيح، يجب اختيار Insurance.'),
						indicator: 'red',
					});
					return;
				}

				// 2. التحقق من العميل
				if (!frm.doc.customer) {
					frappe.msgprint({
						title: __('تنبيه'),
						message: __('من فضلك اختر العميل أولاً.'),
						indicator: 'orange',
					});
					return;
				}
				open_insurance_dialog(frm);
			})
			.addClass('btn-info');
	},
});

// ========================= الدialog الرئيسي =========================

function open_insurance_dialog(frm) {
	frappe.model.with_doctype('Customer', () => {
		frappe.model.with_doctype('Insurance Data', () => {
			_open_insurance_dialog_logic(frm);
		});
	});
}

function _open_insurance_dialog_logic(frm) {
	// 1. Discover Fields Types to know which are Links
	let field_types = {};
	const meta = frappe.get_meta('Insurance Data');
	if (meta && meta.fields) {
		meta.fields.forEach((df) => {
			field_types[df.fieldname] = {
				type: df.fieldtype,
				options: df.options,
				label: df.label,
			};
		});
	}

	// 2. Discover correct field mapping
	let col_map = Object.assign({}, INSURANCE_FIELDNAMES);
	if (meta && meta.fields) {
		const label_map = {
			company: 'company',
			'insurance company': 'company',
			policy: 'policy_no',
			'patient name': 'patient_name',
			'id number': 'id_no',
			'id no': 'id_no',
			category: 'category',
			expiry: 'expiry',
			'category name': 'cat_name',
			'category type': 'cat_type',
			membership: 'mem_no',
			nationality: 'nationality',
			age: 'age',
			file: 'file_no',

			gender: 'gender',
			marital: 'marital_status',
			birth: 'berth_date',
			religion: 'religion',
			job: 'current_job',

			'approval number': 'custom_approval_number',
			'approval date': 'custom_approval_date',
			'custom insurance company': 'custom_insurance_company',
			'contract discount': 'custom_contract_discount',
			'approval amount': 'custom_approval_amount',
			'insurance percentage': 'custom_insurance_percentage',
			'maximum limit': 'custom_maximum_limit',
		};

		meta.fields.forEach((df) => {
			const fieldname = (df.fieldname || '').toLowerCase();
			if (
				fieldname === 'birth_date' ||
				fieldname === 'date_of_birth' ||
				fieldname === 'dob'
			) {
				col_map.berth_date = df.fieldname;
			}

			if (fieldname === 'marital' || fieldname === 'marital_status') {
				col_map.marital_status = df.fieldname;
			}

			if (fieldname === 'gender') col_map.gender = df.fieldname;
			if (fieldname === 'religion') col_map.religion = df.fieldname;
			if (fieldname === 'current_job' || fieldname === 'job' || fieldname === 'occupation')
				col_map.current_job = df.fieldname;
			if (fieldname === 'custom_approval_number')
				col_map.custom_approval_number = df.fieldname;
			if (fieldname === 'custom_approval_date') col_map.custom_approval_date = df.fieldname;

			const label = (df.label || '').toLowerCase();
			for (const k in label_map) {
				if (!label.includes(k)) continue;
				if (k === 'category' && (label.includes('name') || label.includes('type')))
					continue;
				col_map[label_map[k]] = df.fieldname;
			}
		});
	}

	// Helper to get field config
	const get_conf = (key, override_label) => {
		const fname = col_map[key];
		let ftype = 'Data';
		let fopt = null;
		let flabel = override_label || key;

		// 1. Try to get config from Child Table (Insurance Data)
		if (field_types[fname]) {
			ftype = field_types[fname].type === 'Link' ? 'Link' : field_types[fname].type;
			fopt = field_types[fname].options;
			flabel = field_types[fname].label;
		}
		// 2. Try to get config from Parent Form (Sales Order) for Custom Fields
		else if (frm.fields_dict[key]) {
			const parent_df = frm.fields_dict[key].df;
			ftype = parent_df.fieldtype;
			fopt = parent_df.options;
			flabel = override_label || parent_df.label;
		}
		// 3. Fallbacks
		else {
			if (
				key.includes('amount') ||
				key.includes('discount') ||
				key.includes('percentage') ||
				key.includes('limit')
			) {
				ftype = 'Float';
			}
			// Last resort if still unknown
		}

		return { fieldname: key, label: flabel, fieldtype: ftype, options: fopt };
	};

	const d = new frappe.ui.Dialog({
		title: __('بيانات التأمين (Insurance Data)'),
		size: 'large',
		fields: [
			{ fieldtype: 'Section Break', label: 'بيانات شركة التأمين' },
			{ fieldtype: 'Column Break' },
			get_conf('custom_insurance_company', 'Insurance Company (Custom)'),
			Object.assign(get_conf('custom_contract_discount', 'Contract Discount'), {
				hidden: 1,
			}),
			get_conf('custom_approval_number', 'Approval Number'),
			get_conf('custom_approval_date', 'Approval Date'),
			get_conf('custom_approval_amount', 'Approval Amount'),

			{ fieldtype: 'Column Break' },
			get_conf('custom_insurance_percentage', 'Insurance Percentage'),
			get_conf('custom_maximum_limit', 'Maximum Limit'),

			{ fieldtype: 'Section Break', label: 'البيانات الأساسية' },
			{ fieldtype: 'Column Break' },
			get_conf('company'),
			get_conf('policy_no'),
			get_conf('patient_name'),
			get_conf('id_no'),
			Object.assign(get_conf('gender'), { reqd: 1 }),
			get_conf('marital_status'),

			{ fieldtype: 'Column Break' },
			get_conf('category'),
			{ fieldname: 'expiry', label: 'Expiry Date', fieldtype: 'Date' },
			get_conf('cat_name'),
			get_conf('cat_type'),
			get_conf('berth_date'),
			get_conf('religion'),

			{ fieldtype: 'Column Break' },
			get_conf('mem_no'),
			get_conf('nationality'),
			get_conf('age'),
			get_conf('file_no'),
			get_conf('current_job'),

			{ fieldtype: 'Section Break', label: '📜 البيانات المسجلة في هذا الأمر' },
			{ fieldname: 'order_insurance_html', fieldtype: 'HTML' },
			{ fieldtype: 'Section Break', label: '📂 البيانات السابقة لهذا العميل' },
			{ fieldname: 'previous_insurance_html', fieldtype: 'HTML' },
			{ fieldtype: 'Section Break' },
		],
		primary_action_label: __('حفظ في أمر البيع'),
		primary_action: function () {
			save_new_insurance(frm, d);
		},
	});

	d.custom_ins_col_map = col_map;
	if (d.fields_dict.custom_approval_date) {
		d.set_df_property('custom_approval_date', 'read_only', 1);
		d.set_value('custom_approval_date', frappe.datetime.get_today());
	}
	const is_locked = frm.doc.docstatus === 1 || frm.doc.docstatus === 2;
	if (is_locked) {
		Object.keys(INSURANCE_FIELDNAMES).forEach((fname) => {
			if (d.fields_dict[fname]) d.set_df_property(fname, 'read_only', 1);
		});
		d.set_primary_action(__('إغلاق'), () => d.hide());
	}
	d.$wrapper.find('.modal-dialog').css('max-width', '1100px');
	d.$wrapper.find('.modal-content').css('max-height', '90vh');
	d.$wrapper.find('.modal-body').css('max-height', '70vh').css('overflow-y', 'auto');

	// Mirroring Logic (Sync fields)
	// 1. Company <-> Custom Insurance Company
	const sync_fields = (f1, f2) => {
		if (d.fields_dict[f1] && d.fields_dict[f2]) {
			d.fields_dict[f1].df.onchange = () => {
				const val = d.get_value(f1);
				// Update Dialog Sync
				if (val !== d.get_value(f2)) {
					d.set_value(f2, val);
				}

				// Real-time Sync to Parent Form (Sales Order)
				// This allows parent scripts (fetch_from, client scripts) to run immediately
				if (frm.fields_dict[f2]) {
					frm.set_value(f2, val).then(() => {
						// After parent updates, check if other dependent fields changed (e.g. Contract Discount)
						// And pull them back into the dialog
						const discount = frm.doc.custom_contract_discount;
						const amount = frm.doc.custom_approval_amount;
						const percentage = frm.doc.custom_insurance_percentage;
						const limit = frm.doc.custom_maximum_limit;

						if (discount && d.fields_dict.custom_contract_discount)
							d.set_value('custom_contract_discount', discount);
						if (amount && d.fields_dict.custom_approval_amount)
							d.set_value('custom_approval_amount', amount);
						if (percentage && d.fields_dict.custom_insurance_percentage)
							d.set_value('custom_insurance_percentage', percentage);
						if (limit && d.fields_dict.custom_maximum_limit)
							d.set_value('custom_maximum_limit', limit);
					});
				}
			};

			d.fields_dict[f2].df.onchange = () => {
				const val = d.get_value(f2);
				if (val !== d.get_value(f1)) d.set_value(f1, val);

				// Sync to parent here too
				if (frm.fields_dict[f2]) {
					frm.set_value(f2, val).then(() => {
						// Pull back dependents
						const discount = frm.doc.custom_contract_discount;
						if (discount && d.fields_dict.custom_contract_discount)
							d.set_value('custom_contract_discount', discount);
						// ... others as needed
					});
				}
			};
		}
	};

	sync_fields('company', 'custom_insurance_company');

	// Also sync other custom fields immediately when typed in Dialog
	const direct_sync = (fname) => {
		if (d.fields_dict[fname]) {
			d.fields_dict[fname].df.onchange = () => {
				const val = d.get_value(fname);
				if (frm.fields_dict[fname]) {
					frm.set_value(fname, val);
				}
			};
		}
	};

	direct_sync('custom_contract_discount');
	direct_sync('custom_approval_amount');
	direct_sync('custom_insurance_percentage');
	direct_sync('custom_maximum_limit');
	direct_sync('custom_approval_number');
	// Add other syncs here if needed

	// Discover Table Name
	const cust_meta = frappe.get_meta('Customer');
	if (cust_meta) {
		const field = cust_meta.fields.find(
			(df) => df.fieldtype === 'Table' && df.options === 'Insurance Data',
		);
		if (field) d.custom_ins_table_field = field.fieldname;
	}

	load_insurance_from_order(frm, d);
	render_order_insurance_table(frm, d);
	load_previous_insurance(frm, d);
	d.show();
}

function render_order_insurance_table(frm, dialog) {
	const wrapper = dialog.fields_dict.order_insurance_html.$wrapper;
	wrapper.empty();
	dialog.order_insurance = dialog.order_insurance || [];
	const items = dialog.order_insurance;
	const is_locked = frm.doc.docstatus === 1 || frm.doc.docstatus === 2;

	let html = `
        <div class="mb-2 text-muted small">يمكنك إضافة أكثر من سجل، وسيتم اعتماد آخر سجل تلقائياً.</div>
        <table class="table table-bordered table-condensed" style="table-layout: fixed; width: 100%;">
            <thead><tr style="background:#f5f5f5;"><th style="width:40px;">#</th><th>Company</th><th>Policy</th><th>Patient</th><th>ID</th><th>Expiry</th><th style="width:80px;">إجراء</th></tr></thead>
            <tbody>
    `;

	if (!items.length) {
		html += `<tr><td colspan="7" class="text-center text-muted">لا يوجد بيانات مسجلة لهذا الأمر.</td></tr>`;
	} else {
		items.forEach((item, idx) => {
			html += `
                <tr>
                    <td>${idx + 1}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(
						item.company || '',
					)}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(
						item.policy_no || '',
					)}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(
						item.patient_name || '',
					)}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(
						item.id_no || '',
					)}</td>
                    <td style="word-wrap: break-word;">${
						frappe.format(item.expiry, { fieldtype: 'Date' }) || ''
					}</td>
                    <td>
                        ${
							is_locked
								? `<span class="text-muted">—</span>`
								: `<button class="btn btn-xs btn-danger so-ins-remove" data-idx="${idx}">${__(
										'حذف',
								  )}</button>`
						}
                    </td>
                </tr>
            `;
		});
	}
	html += `</tbody></table>`;
	wrapper.html(html);
	if (!is_locked) {
		wrapper.find('.so-ins-remove').on('click', function () {
			const idx = parseInt($(this).attr('data-idx'), 10);
			dialog.order_insurance.splice(idx, 1);
			const fn = ORDER_INSURANCE_CHILD_FIELD;
			if (frm.doc && fn && Array.isArray(frm.doc[fn]) && frm.doc[fn].length > idx) {
				frm.doc[fn].splice(idx, 1);
				frm.refresh_field(fn);
			}
			render_order_insurance_table(frm, dialog);
		});
	}
}

function apply_insurance_to_dialog(dialog, item) {
	dialog.set_value('company', item.company);
	dialog.set_value('policy_no', item.policy_no);
	dialog.set_value('patient_name', item.patient_name);
	dialog.set_value('id_no', item.id_no);
	dialog.set_value('gender', item.gender);
	dialog.set_value('marital_status', item.marital_status);
	dialog.set_value('berth_date', item.berth_date);
	dialog.set_value('religion', item.religion);
	dialog.set_value('current_job', item.current_job);
	dialog.set_value('category', item.category);
	dialog.set_value('expiry', item.expiry);
	dialog.set_value('cat_name', item.cat_name);
	dialog.set_value('cat_type', item.cat_type);
	dialog.set_value('mem_no', item.mem_no);
	dialog.set_value('nationality', item.nationality);
	dialog.set_value('age', item.age);
	dialog.set_value('file_no', item.file_no);

	dialog.set_value('custom_insurance_company', item.custom_insurance_company);
	dialog.set_value('custom_contract_discount', item.custom_contract_discount);
	dialog.set_value('custom_approval_number', item.custom_approval_number);
	dialog.set_value('custom_approval_date', frappe.datetime.get_today());
	dialog.set_value('custom_approval_amount', item.custom_approval_amount);
	dialog.set_value('custom_insurance_percentage', item.custom_insurance_percentage);
	dialog.set_value('custom_maximum_limit', item.custom_maximum_limit);
}

function extract_insurance_from_row(row, FN) {
	return {
		company: row[FN.company],
		policy_no: row[FN.policy_no],
		patient_name: row[FN.patient_name],
		id_no: row[FN.id_no],
		gender: row[FN.gender],
		marital_status: row[FN.marital_status],
		berth_date: row[FN.berth_date],
		religion: row[FN.religion],
		current_job: row[FN.current_job],
		category: row[FN.category],
		expiry: row[FN.expiry],
		cat_name: row[FN.cat_name],
		cat_type: row[FN.cat_type],
		mem_no: row[FN.mem_no],
		nationality: row[FN.nationality],
		age: row[FN.age],
		file_no: row[FN.file_no],
		custom_insurance_company: row[FN.custom_insurance_company],
		custom_contract_discount: row[FN.custom_contract_discount],
		custom_approval_number: row[FN.custom_approval_number],
		custom_approval_date: row[FN.custom_approval_date],
		custom_approval_amount: row[FN.custom_approval_amount],
		custom_insurance_percentage: row[FN.custom_insurance_percentage],
		custom_maximum_limit: row[FN.custom_maximum_limit],
	};
}

function is_same_insurance_item(a, b) {
	const keys = [
		'company',
		'policy_no',
		'patient_name',
		'id_no',
		'gender',
		'marital_status',
		'berth_date',
		'religion',
		'current_job',
		'category',
		'expiry',
		'cat_name',
		'cat_type',
		'mem_no',
		'nationality',
		'age',
		'file_no',
		'custom_insurance_company',
		'custom_contract_discount',
		'custom_approval_number',
		'custom_approval_amount',
		'custom_insurance_percentage',
		'custom_maximum_limit',
	];
	return keys.every((k) => (a && a[k]) === (b && b[k]));
}

function is_same_insurance_row(row, item, FN) {
	const pairs = [
		['company', FN.company],
		['policy_no', FN.policy_no],
		['patient_name', FN.patient_name],
		['id_no', FN.id_no],
		['gender', FN.gender],
		['marital_status', FN.marital_status],
		['berth_date', FN.berth_date],
		['religion', FN.religion],
		['current_job', FN.current_job],
		['category', FN.category],
		['expiry', FN.expiry],
		['cat_name', FN.cat_name],
		['cat_type', FN.cat_type],
		['mem_no', FN.mem_no],
		['nationality', FN.nationality],
		['age', FN.age],
		['file_no', FN.file_no],
		['custom_insurance_company', FN.custom_insurance_company],
		['custom_contract_discount', FN.custom_contract_discount],
		['custom_approval_number', FN.custom_approval_number],
		['custom_approval_amount', FN.custom_approval_amount],
		['custom_insurance_percentage', FN.custom_insurance_percentage],
		['custom_maximum_limit', FN.custom_maximum_limit],
	];
	return pairs.every(([k, f]) => {
		if (!f) return (item && item[k]) == null;
		return (row && row[f]) === (item && item[k]);
	});
}

function load_insurance_from_order(frm, dialog) {
	const fn = ORDER_INSURANCE_CHILD_FIELD;
	const FN = dialog.custom_ins_col_map || INSURANCE_FIELDNAMES;
	const rows = (frm.doc && frm.doc[fn]) || [];
	if (!rows.length) {
		if (dialog.fields_dict.custom_approval_number && frm.doc.custom_approval_number != null) {
			dialog.set_value('custom_approval_number', frm.doc.custom_approval_number);
		}
		if (dialog.fields_dict.custom_approval_date) {
			dialog.set_value('custom_approval_date', frappe.datetime.get_today());
		}
		return;
	}

	const items = rows.map((row) => extract_insurance_from_row(row, FN));
	items.forEach((it) => {
		if (it.custom_approval_number == null)
			it.custom_approval_number = frm.doc.custom_approval_number;
		it.custom_approval_date = frappe.datetime.get_today();
	});
	dialog.order_insurance = items;
	const item = items[items.length - 1];
	if (item) {
		apply_insurance_to_dialog(dialog, item);
		dialog.__auto_loaded = true;
	}
}

function set_insurance_on_order(dialog) {
	const v = dialog.get_values();
	const data = {
		company: v.company,
		policy_no: v.policy_no,
		patient_name: v.patient_name,
		id_no: v.id_no,
		gender: v.gender,
		marital_status: v.marital_status,
		berth_date: v.berth_date,
		religion: v.religion,
		current_job: v.current_job,
		category: v.category,
		expiry: v.expiry,
		cat_name: v.cat_name,
		cat_type: v.cat_type,
		mem_no: v.mem_no,
		nationality: v.nationality,
		age: v.age,
		file_no: v.file_no,

		// New Fields
		custom_insurance_company: v.custom_insurance_company,
		custom_contract_discount: v.custom_contract_discount,
		custom_approval_number: v.custom_approval_number,
		custom_approval_date: frappe.datetime.get_today(),
		custom_approval_amount: v.custom_approval_amount,
		custom_insurance_percentage: v.custom_insurance_percentage,
		custom_maximum_limit: v.custom_maximum_limit,
	};
	dialog.order_insurance = dialog.order_insurance || [];
	const last = dialog.order_insurance[dialog.order_insurance.length - 1];
	if (!last || !is_same_insurance_item(last, data)) {
		dialog.order_insurance.push(data);
	}
}

function save_new_insurance(frm, dialog) {
	const v = dialog.get_values();
	if (!v) return;

	try {
		set_insurance_on_order(dialog);
	} catch (e) {
		frappe.msgprint({ title: __('تحذير'), message: e.message, indicator: 'orange' });
		return;
	}

	const item = dialog.order_insurance[dialog.order_insurance.length - 1];

	frappe.call({
		method: 'frappe.client.get',
		args: { doctype: 'Customer', name: frm.doc.customer },
		callback(r) {
			const customer = r.message;
			if (!customer) return;

			const target_field = dialog.custom_ins_table_field || CUSTOMER_INSURANCE_CHILD_FIELD;
			const FN = dialog.custom_ins_col_map || INSURANCE_FIELDNAMES;

			customer[target_field] = customer[target_field] || [];
			const last_row = customer[target_field][customer[target_field].length - 1];
			const should_add = !last_row || !is_same_insurance_row(last_row, item, FN);

			if (should_add) {
				const new_row = {
					doctype: 'Insurance Data',
					parent: customer.name,
					parenttype: 'Customer',
					parentfield: target_field,
					so: frm.doc.name || '',
				};
				new_row[FN.company] = item.company;
				new_row[FN.policy_no] = item.policy_no;
				new_row[FN.patient_name] = item.patient_name;
				new_row[FN.id_no] = item.id_no;
				if (FN.gender) new_row[FN.gender] = item.gender;
				if (FN.marital_status) new_row[FN.marital_status] = item.marital_status;
				if (FN.berth_date) new_row[FN.berth_date] = item.berth_date;
				if (FN.religion) new_row[FN.religion] = item.religion;
				if (FN.current_job) new_row[FN.current_job] = item.current_job;
				new_row[FN.category] = item.category;
				new_row[FN.expiry] = item.expiry;
				new_row[FN.cat_name] = item.cat_name;
				new_row[FN.cat_type] = item.cat_type;
				new_row[FN.mem_no] = item.mem_no;
				new_row[FN.nationality] = item.nationality;
				new_row[FN.age] = item.age;
				new_row[FN.file_no] = item.file_no;

				if (FN.custom_insurance_company)
					new_row[FN.custom_insurance_company] = item.custom_insurance_company;
				if (FN.custom_contract_discount)
					new_row[FN.custom_contract_discount] = item.custom_contract_discount;
				if (FN.custom_approval_number)
					new_row[FN.custom_approval_number] = item.custom_approval_number;
				if (FN.custom_approval_date)
					new_row[FN.custom_approval_date] = item.custom_approval_date;
				if (FN.custom_approval_amount)
					new_row[FN.custom_approval_amount] = item.custom_approval_amount;
				if (FN.custom_insurance_percentage)
					new_row[FN.custom_insurance_percentage] = item.custom_insurance_percentage;
				if (FN.custom_maximum_limit)
					new_row[FN.custom_maximum_limit] = item.custom_maximum_limit;

				customer[target_field].push(new_row);

				frappe.call({
					method: 'frappe.client.save',
					args: { doc: customer },
					callback() {
						finish_save();
						dialog.hide();
					},
					error(err) {
						console.warn('Save failed, linking to SO only', err);
						frappe.msgprint({
							title: __('تنبيه'),
							message: __(
								'تعذر الحفظ في ملف العميل (بيانات غير موجودة أو صلاحيات)، تم الربط بأمر البيع فقط.',
							),
							indicator: 'orange',
						});
						finish_save();
					},
				});
			} else {
				finish_save();
				dialog.hide();
			}

			function finish_save() {
				link_insurance_to_sales_order(frm, item, FN);
				load_insurance_from_order(frm, dialog);
				render_order_insurance_table(frm, dialog);
				load_previous_insurance(frm, dialog);
			}
		},
	});
}

function link_insurance_to_sales_order(frm, item, field_map) {
	const fn = ORDER_INSURANCE_CHILD_FIELD;
	const FN = field_map || INSURANCE_FIELDNAMES;

	// 1. Update Parent Fields (Sales Order Header)
	// الحقول الأساسية في أمر البيع
	// نستخدم set_value لتفعيل أي scripts تعتمد عليها

	const parent_updates = {};
	if (item.custom_insurance_company)
		parent_updates['custom_insurance_company'] = item.custom_insurance_company;
	if (item.custom_contract_discount)
		parent_updates['custom_contract_discount'] = item.custom_contract_discount;
	if (item.custom_approval_number)
		parent_updates['custom_approval_number'] = item.custom_approval_number;
	if (item.custom_approval_date)
		parent_updates['custom_approval_date'] = item.custom_approval_date;
	if (item.custom_approval_amount)
		parent_updates['custom_approval_amount'] = item.custom_approval_amount;
	if (item.custom_insurance_percentage)
		parent_updates['custom_insurance_percentage'] = item.custom_insurance_percentage;
	if (item.custom_maximum_limit)
		parent_updates['custom_maximum_limit'] = item.custom_maximum_limit;

	// تطبيق التحديثات على الهيدر
	if (Object.keys(parent_updates).length > 0) {
		frm.set_value(parent_updates);
	}

	// 2. Update Child Table
	if (!fn || !frm.fields_dict[fn]) {
		console.warn('Insurance child table not found on Sales Order.');
		return;
	}
	frm.doc[fn] = frm.doc[fn] || [];
	const last_row = frm.doc[fn][frm.doc[fn].length - 1];
	let row;
	if (!last_row || !is_same_insurance_row(last_row, item, FN)) {
		row = frm.add_child(fn);
	} else {
		row = last_row;
	}

	row[FN.company] = item.company;
	row[FN.policy_no] = item.policy_no;
	row[FN.patient_name] = item.patient_name;
	row[FN.id_no] = item.id_no;
	if (FN.gender) row[FN.gender] = item.gender;
	if (FN.marital_status) row[FN.marital_status] = item.marital_status;
	if (FN.berth_date) row[FN.berth_date] = item.berth_date;
	if (FN.religion) row[FN.religion] = item.religion;
	if (FN.current_job) row[FN.current_job] = item.current_job;
	row[FN.category] = item.category;
	row[FN.expiry] = item.expiry;
	row[FN.cat_name] = item.cat_name;
	row[FN.cat_type] = item.cat_type;
	row[FN.mem_no] = item.mem_no;
	row[FN.nationality] = item.nationality;
	row[FN.age] = item.age;
	row[FN.file_no] = item.file_no;

	// Also save custom fields to child table if columns exist there
	if (FN.custom_insurance_company)
		row[FN.custom_insurance_company] = item.custom_insurance_company;
	if (FN.custom_contract_discount)
		row[FN.custom_contract_discount] = item.custom_contract_discount;
	if (FN.custom_approval_number) row[FN.custom_approval_number] = item.custom_approval_number;
	if (FN.custom_approval_date) row[FN.custom_approval_date] = item.custom_approval_date;
	if (FN.custom_approval_amount) row[FN.custom_approval_amount] = item.custom_approval_amount;
	if (FN.custom_insurance_percentage)
		row[FN.custom_insurance_percentage] = item.custom_insurance_percentage;
	if (FN.custom_maximum_limit) row[FN.custom_maximum_limit] = item.custom_maximum_limit;

	frm.refresh_field(fn);
}

function load_previous_insurance(frm, dialog) {
	const wrapper = dialog.fields_dict.previous_insurance_html.$wrapper;
	wrapper.empty();
	if (!frm.doc.customer) {
		wrapper.html(`<div class="text-muted small">اختر العميل أولاً.</div>`);
		return;
	}
	const is_locked = frm.doc.docstatus === 1 || frm.doc.docstatus === 2;

	frappe.call({
		method: 'frappe.client.get',
		args: { doctype: 'Customer', name: frm.doc.customer },
		callback(r) {
			const customer = r.message;
			if (!customer) {
				wrapper.html(
					`<div class="text-muted small">لم يتم العثور على بيانات العميل.</div>`,
				);
				return;
			}

			const target_field = dialog.custom_ins_table_field || CUSTOMER_INSURANCE_CHILD_FIELD;
			let arr = customer[target_field] || [];
			const FN = dialog.custom_ins_col_map || INSURANCE_FIELDNAMES;

			if (!arr.length) {
				wrapper.html(`<div class="text-muted small">لا توجد بيانات سابقة.</div>`);
				return;
			}

			let html = `
                <table class="table table-bordered table-condensed" style="table-layout: fixed; width: 100%;">
                    <thead><tr style="background:#f5f5f5;"><th style="width:40px;">#</th><th>Company</th><th>Policy</th><th>Patient</th><th>ID</th><th>Expiry</th><th style="width:80px;">اختيار</th></tr></thead>
                    <tbody>
            `;
			arr.forEach((row, idx) => {
				html += `
                    <tr>
                        <td>${idx + 1}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(
							row[FN.company] || '',
						)}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(
							row[FN.policy_no] || '',
						)}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(
							row[FN.patient_name] || '',
						)}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(
							row[FN.id_no] || '',
						)}</td>
                        <td style="word-wrap: break-word;">${
							frappe.format(row[FN.expiry], { fieldtype: 'Date' }) || ''
						}</td>
                        <td>
                            ${
								is_locked
									? `<span class="text-muted">—</span>`
									: `<button class="btn btn-xs btn-primary so-ins-use" data-idx="${idx}">${__(
											'استخدام',
									  )}</button>`
							}
                        </td>
                    </tr>
                `;
			});
			html += `</tbody></table>`;
			wrapper.html(html);

			const fn = ORDER_INSURANCE_CHILD_FIELD;
			const order_rows = (frm.doc && frm.doc[fn]) || [];
			if (!order_rows.length && !dialog.__auto_loaded) {
				const last = arr[arr.length - 1];
				const item = extract_insurance_from_row(last, FN);
				apply_insurance_to_dialog(dialog, item);
				dialog.__auto_loaded = true;
			}

			if (!is_locked) {
				wrapper.find('.so-ins-use').on('click', function () {
					const idx = parseInt($(this).attr('data-idx'), 10);
					const row = arr[idx];
					const item = extract_insurance_from_row(row, FN);
					apply_insurance_to_dialog(dialog, item);
				});
			}
		},
	});
}

// ============================================
// File 13: mode_of_payment_account.js
// ============================================
// Client Script — Doctype: "Sales Order"
frappe.ui.form.on('Sales Order', {
	custom_payment_on_form_rendered(frm) {
		// Filter payment modes to show only enabled ones
		frm.fields_dict.custom_payment.grid.get_field('mode_of_payment').get_query = function () {
			return {
				filters: { enabled: 1 },
			};
		};
	},
});

frappe.ui.form.on('Sales Order Payment', {
	mode_of_payment: async function (frm, cdt, cdn) {
		let row = locals[cdt][cdn];

		if (row.mode_of_payment && frm.doc.company) {
			try {
				// Load Mode of Payment record itself (without accessing Mode of Payment Account directly)
				const mop = await frappe.db.get_doc('Mode of Payment', row.mode_of_payment);

				if (mop && mop.accounts && mop.accounts.length > 0) {
					// Try to find default account for same company
					const account_row = mop.accounts.find((a) => a.company === frm.doc.company);

					if (account_row && account_row.default_account) {
						frappe.model.set_value(cdt, cdn, 'account', account_row.default_account);
					} else {
						frappe.model.set_value(cdt, cdn, 'account', null);
						frappe.msgprint(
							__(
								'لم يتم العثور على الحساب الافتراضي لهذا النوع من الدفع لهذه الشركة.',
							),
						);
					}
				} else {
					frappe.model.set_value(cdt, cdn, 'account', null);
					frappe.msgprint(__('لم يتم العثور على إعدادات الحسابات في وضع الدفع.'));
				}
			} catch (e) {
				frappe.msgprint(__('حدث خطأ أثناء جلب بيانات وضع الدفع.'));
				console.error(e);
			}
		}
	},
});

// ============================================
// File 14: multi_add_button.js
// ============================================
// ===============================
// Multi Add Button for Native Items Table
// Adds a Multi Add button below the native items child table
// Independent script - no relation to custom_items_table
// Adds items directly to the native items child table
// ===============================

frappe.ui.form.on('Sales Order', {
	refresh(frm) {
		// Only add button if items field exists
		if (!frm.fields_dict.items) return;

		// Get the grid object
		const grid = frm.fields_dict.items.grid;
		if (!grid) return;

		// Add Multi Add button below the native items table
		// This button is independent and always shows for native items table
		if (!frm._multi_add_button_added) {
			grid.add_custom_button(
				__('📦 Multi Add Items'),
				function () {
					open_multi_add_dialog_for_native_table(frm);
				},
				'bottom',
			);
			frm._multi_add_button_added = true;
		}
	},
});

// Multi Add dialog for native items table
function open_multi_add_dialog_for_native_table(frm) {
	console.log('[Multi Add Native] Opening dialog', { frm: frm.doc.name });
	const default_wh = frm.doc.set_warehouse || '';

	const d = new frappe.ui.Dialog({
		title: __('Multi Add Items'),
		size: 'large',
		fields: [
			{
				fieldname: 'warehouse',
				label: 'Warehouse',
				fieldtype: 'Link',
				options: 'Warehouse',
				default: default_wh,
				reqd: 1,
			},
			{
				fieldname: 'search',
				label: 'Search Item (code / name)',
				fieldtype: 'Data',
			},
			{
				fieldname: 'results',
				fieldtype: 'HTML',
			},
		],
		primary_action_label: __('Add Selected'),
		primary_action(values) {
			if (!frm.doc.customer) {
				frappe.msgprint({ message: __('Please select Customer first'), indicator: 'red' });
				return;
			}
			console.log('[Multi Add Native] Add Selected clicked', {
				values,
				warehouse: values.warehouse,
			});
			const $tbody = $(d.get_field('results').$wrapper).find('tbody');
			let added_count = 0;

			const rows_to_add = [];
			$tbody.find('tr[data-item-code]').each(function () {
				const $r = $(this);
				const qty = parseFloat($r.find('.multi-qty').val()) || 0;
				const item_code = $r.attr('data-item-code');
				console.log('[Multi Add Native] Checking row', { item_code, qty });

				if (!qty || qty <= 0) {
					console.log('[Multi Add Native] Skipping row - qty is 0 or invalid', {
						item_code,
						qty,
					});
					return;
				}

				if (!item_code) {
					console.log('[Multi Add Native] Skipping row - no item_code', { item_code });
					return;
				}

				rows_to_add.push({ item_code, qty, warehouse: values.warehouse || '' });
			});

			console.log('[Multi Add Native] Rows to add', rows_to_add);

			// Add items to native items table
			// Use a promise chain to ensure items are added sequentially
			let promise_chain = Promise.resolve();

			rows_to_add.forEach((row_data) => {
				promise_chain = promise_chain.then(() => {
					console.log('[Multi Add Native] Adding row to native table', row_data);

					return new Promise((resolve) => {
						// Add child row to native items table
						const child = frm.add_child('items');
						child.qty = row_data.qty;
						child.warehouse = row_data.warehouse || frm.doc.set_warehouse || '';
						child.delivery_date =
							frm.doc.delivery_date ||
							frm.doc.transaction_date ||
							frappe.datetime.nowdate();

						// Set item_code which will trigger item_code change event to fetch details
						frappe.model
							.set_value(child.doctype, child.name, 'item_code', row_data.item_code)
							.then(() => {
								added_count++;
								resolve();
							});
					});
				});
			});

			promise_chain.then(() => {
				console.log('[Multi Add Native] Total rows added', added_count);

				if (added_count > 0) {
					// Refresh the items field to show the new rows
					frm.refresh_field('items');
					frappe.show_alert({
						message: __('{0} item(s) added', [added_count]),
						indicator: 'green',
					});
				}
			});

			d.hide();
		},
	});

	const results_html = $(`
        <div style="max-height:400px;overflow:auto;">
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
    `);
	d.get_field('results').$wrapper.html(results_html);
	const $tbody = results_html.find('tbody');

	const search_field = d.get_field('search');
	search_field.df.onchange = () => {
		const txt = search_field.get_value();
		const wh = d.get_value('warehouse');
		if (!txt || !wh) return;
		search_items_with_stock_for_native(txt, wh, $tbody);
	};

	d.show();
}

// Search items + stock for native items table
function search_items_with_stock_for_native(txt, warehouse, $tbody) {
	console.log('[Search Items Native] Starting search', { txt, warehouse });
	$tbody.empty();

	frappe.call({
		method: 'frappe.desk.search.search_link',
		args: {
			doctype: 'Item',
			txt: txt,
			page_length: 20,
		},
		callback(r) {
			const results = r.results || r.message || [];
			console.log('[Search Items Native] Search results', {
				count: results.length,
				results,
			});
			if (!results.length) {
				console.log('[Search Items Native] No items found');
				$tbody.append(
					'<tr><td colspan="4" style="padding:8px;text-align:center;color:#999;">No Items Found</td></tr>',
				);
				return;
			}

			const item_codes = results.map((x) => x.value);
			console.log('[Search Items Native] Item codes to check stock', item_codes);

			frappe.call({
				method: 'frappe.client.get_list',
				args: {
					doctype: 'Bin',
					filters: { warehouse: warehouse, item_code: ['in', item_codes] },
					fields: ['item_code', 'actual_qty', 'reserved_qty'],
					limit_page_length: 100,
				},
				callback(b) {
					const bins = {};
					(b.message || []).forEach((bin) => {
						bins[bin.item_code] = (bin.actual_qty || 0) - (bin.reserved_qty || 0);
					});

					results.forEach((rw) => {
						const available = bins[rw.value] || 0;
						const tr = $(`
                            <tr data-item-code="${
								rw.value
							}" style="border-bottom:1px solid #e0e0e0;" onmouseover="this.style.backgroundColor='#f9f9f9';" onmouseout="this.style.backgroundColor='transparent';">
                                <td style="padding:8px;border:1px solid #d1d8dd;">${rw.value}</td>
                                <td style="padding:8px;border:1px solid #d1d8dd;">${frappe.utils.escape_html(
									rw.description || rw.value,
								)}</td>
                                <td style="padding:8px;border:1px solid #d1d8dd;">${available.toFixed(
									2,
								)}</td>
                                <td style="padding:8px;border:1px solid #d1d8dd;"><input type="number" class="multi-qty" step="0.001" value="0" style="width:100%;padding:4px 6px;height:28px;font-size:12px;box-sizing:border-box;border:1px solid #d1d8dd;border-radius:3px;"></td>
                            </tr>
                        `);
						$tbody.append(tr);
					});
				},
			});
		},
	});
}

// ============================================
// File 15: order_type.js
// ============================================
frappe.ui.form.on('Sales Order', {
	refresh: function (frm) {
		// Update selling price list from order_type on refresh only if value is different
		// This prevents marking document as dirty unnecessarily
		if (frm.doc.order_type && frm.doc.selling_price_list !== frm.doc.order_type) {
			frm.set_value('selling_price_list', frm.doc.order_type);
		}
	},

	order_type: function (frm) {
		// Update selling price list whenever order_type changes
		if (frm.doc.order_type) {
			frm.set_value('selling_price_list', frm.doc.order_type);
		}
	},
});

// ============================================
// File 16: outstanding.js
// ============================================
frappe.ui.form.on('Sales Order', {
	refresh: function (frm) {
		frm.set_value(
			'custom_outstanding_amount',
			Math.round((frm.doc.grand_total || 0) - (frm.doc.advance_paid || 0)),
		);
	},
	grand_total: function (frm) {
		frm.set_value(
			'custom_outstanding_amount',
			Math.round((frm.doc.grand_total || 0) - (frm.doc.advance_paid || 0)),
		);
	},
	advance_paid: function (frm) {
		frm.set_value(
			'custom_outstanding_amount',
			Math.round((frm.doc.grand_total || 0) - (frm.doc.advance_paid || 0)),
		);
	},
});

// ============================================
// File 18: payment_entry_sales_order.js
// ============================================
frappe.ui.form.on('Sales Order', {
	refresh(frm) {
		console.log(
			'KH Quick Pay: refresh on Sales Order',
			frm.doc.name,
			'docstatus:',
			frm.doc.docstatus,
		);

		// Only work after Submit
		if (frm.doc.docstatus !== 1) return;

		frm.add_custom_button(__('💰 تسجيل دفع (Popup)'), function () {
			open_quick_payment_dialog_for_so(frm);
		}).addClass('btn-danger');
	},
});

function open_quick_payment_dialog_for_so(frm) {
	const d = new frappe.ui.Dialog({
		title: __('تسجيل دفع لأمر البيع ') + frm.doc.name,
		fields: [
			{
				fieldname: 'posting_date',
				fieldtype: 'Date',
				label: __('Posting Date'),
				reqd: 1,
				default: frappe.datetime.get_today(),
			},
			{
				fieldname: 'mode_of_payment',
				fieldtype: 'Link',
				label: __('Mode of Payment'),
				options: 'Mode of Payment',
				reqd: 1,
			},
			{
				fieldname: 'paid_amount',
				fieldtype: 'Currency',
				label: __('Paid Amount'),
				reqd: 1,
				default: frm.doc.custom_outstanding_amount || 0,
			},
			{
				fieldname: 'reference_no',
				fieldtype: 'Data',
				label: __('Reference No'),
			},
			{
				fieldname: 'reference_date',
				fieldtype: 'Date',
				label: __('Reference Date'),
				default: frappe.datetime.get_today(),
			},
		],
		primary_action_label: __('إنشاء سند دفع'),
		primary_action: async function (values) {
			// 1. Validate payment amount
			if (!values.paid_amount || flt(values.paid_amount) <= 0) {
				frappe.msgprint(__('الرجاء إدخال مبلغ دفع صحيح.'));
				return;
			}

			try {
				// 2. Get payment entry template from ERPNext
				const pe_res = await frappe.call({
					method: 'erpnext.accounts.doctype.payment_entry.payment_entry.get_payment_entry',
					args: {
						dt: frm.doc.doctype,
						dn: frm.doc.name,
					},
				});

				if (!pe_res.message) {
					frappe.msgprint(__('تعذر إنشاء سند الدفع.'));
					return;
				}

				// 3. Prepare payment entry with user values
				let pe = pe_res.message;
				pe.mode_of_payment = values.mode_of_payment;

				if (frm.doc.branch) {
					pe.branch = frm.doc.branch;
				}

				pe.posting_date = values.posting_date;
				pe.reference_no = values.reference_no;
				pe.reference_date = values.reference_date;

				// 4. Calculate payment amount and validate against outstanding
				let pay_amount = flt(values.paid_amount);
				if (pe.references && pe.references.length) {
					let ref = pe.references[0];
					let outstanding = flt(ref.outstanding_amount) || flt(ref.total_amount) || 0;
					if (outstanding && pay_amount > outstanding) {
						pay_amount = outstanding;
					}
					ref.allocated_amount = pay_amount;
				}

				// 5. Set payment amounts
				pe.paid_amount = pay_amount;
				pe.received_amount = pay_amount;

				// 6. Get default account from Mode of Payment for the company
				await new Promise((resolve, reject) => {
					frappe.call({
						method: 'erpnext.accounts.doctype.sales_invoice.sales_invoice.get_bank_cash_account',
						args: {
							mode_of_payment: values.mode_of_payment,
							company: frm.doc.company,
						},
						callback: function (r) {
							if (r.message && r.message.account) {
								let payment_account_field =
									pe.payment_type == 'Receive' ? 'paid_to' : 'paid_from';
								pe[payment_account_field] = r.message.account;
								resolve();
							} else {
								reject(
									new Error(
										'لم يتم العثور على حساب افتراضي لطريقة الدفع لهذه الشركة',
									),
								);
							}
						},
					});
				});

				// 7. Insert the payment entry document
				const insert_res = await frappe.call({
					method: 'frappe.client.insert',
					args: { doc: pe },
				});

				if (!insert_res.message) {
					frappe.msgprint(__('حدث خطأ أثناء إنشاء سند الدفع.'));
					return;
				}

				// 8. Submit the payment entry
				const submit_res = await frappe.call({
					method: 'frappe.client.submit',
					args: { doc: insert_res.message },
				});

				if (submit_res.message) {
					frappe.msgprint(
						__('تم إنشاء وتقديم سند الدفع: {0}', [submit_res.message.name]),
					);
					frm.reload_doc();

					d.hide();
				} else {
					frappe.msgprint(__('حدث خطأ أثناء تقديم سند الدفع.'));
				}
			} catch (e) {
				frappe.msgprint(__('حدث خطأ أثناء إنشاء سند الدفع.'));
			}
		},
	});

	d.show();
}

// ============================================
// File 19: payment_schedule.js
// ============================================
// Client Script — Doctype: "Sales Order"
frappe.ui.form.on('Sales Order', {
	setup(frm) {
		// Unified function to force payment due dates
		frm._force_payment_due_dates = function () {
			if (!frm.doc.payment_schedule || !frm.doc.transaction_date) return;

			const tx = frappe.datetime.str_to_obj(frm.doc.transaction_date);
			let changed = false;

			(frm.doc.payment_schedule || []).forEach((row) => {
				// Force date to always be Sales Order date
				if (
					!row.due_date ||
					frappe.datetime.str_to_obj(row.due_date) < tx ||
					row.due_date !== frm.doc.transaction_date
				) {
					row.due_date = frm.doc.transaction_date;
					changed = true;
				}
			});

			if (changed) frm.refresh_field('payment_schedule');
		};
	},

	onload(frm) {
		// When opening Sales Order (even after converting from Quotation)
		frm._force_payment_due_dates();
	},

	refresh(frm) {
		// Only update in refresh if document is already dirty or is new
		// This prevents marking clean documents as dirty
		if (frm.is_dirty() || frm.doc.__islocal) {
			frm._force_payment_due_dates();
		}
	},

	transaction_date(frm) {
		// If user changed Sales Order date, reset payment schedule
		frm._force_payment_due_dates();
	},

	validate(frm) {
		// Most important: right before save — prevents "Due date cannot be before posting date" message
		frm._force_payment_due_dates();
	},

	before_submit(frm) {
		// Final confirmation before submit
		frm._force_payment_due_dates();
	},
});

// ============================================
// File 20: projected_qty2.js
// ============================================
frappe.ui.form.on('Sales Order Item', {
	warehouse: function (frm, cdt, cdn) {
		let row = locals[cdt][cdn];

		if (row.item_code && row.warehouse) {
			frappe.call({
				method: 'frappe.client.get_value',
				args: {
					doctype: 'Bin',
					filters: {
						item_code: row.item_code,
						warehouse: row.warehouse,
					},
					fieldname: ['projected_qty'],
				},
				callback: function (r) {
					frappe.model.set_value(
						cdt,
						cdn,
						'projected_qty',
						r.message ? r.message.projected_qty : 0,
					);
				},
			});
		}
	},
});

// ============================================
// File 21: request_for_quotation.js
// ============================================
frappe.ui.form.on('Sales Order', {
	on_submit: function (frm) {
		if (!frm.doc.branch) {
			frappe.throw('⚠️ يجب تحديد الفرع في أمر البيع.');
		}

		frappe.db
			.get_list('Supplier', {
				filters: { custom_branch: frm.doc.branch },
				fields: ['name', 'supplier_primary_contact'], // Get primary Contact
			})
			.then((suppliers) => {
				if (!suppliers || suppliers.length === 0) {
					frappe.throw(`❌ لا يوجد موردون مرتبطون بالفرع: ${frm.doc.branch}`);
				}

				suppliers.forEach((supplier) => {
					if (!supplier.name) return;

					let rfq = {
						doctype: 'Request for Quotation',
						supplier: supplier.name,
						transaction_date: frappe.datetime.get_today(),
						schedule_date: frappe.datetime.add_days(frappe.datetime.get_today(), 7),
						company: frm.doc.company,
						title: `طلب عرض سعر - ${supplier.name}`,
						message_for_supplier: 'نرجو تزويدنا بعرض السعر في أقرب وقت',
						suppliers: [{ supplier: supplier.name }],
						items: [],
					};

					(frm.doc.items || []).forEach((item) => {
						if (item.item_code && item.qty) {
							rfq.items.push({
								item_code: item.item_code,
								qty: item.qty,
								warehouse: item.warehouse,
								uom: item.uom || 'Nos',
								conversion_factor: 1,
							});
						}
					});

					if (rfq.items.length === 0) {
						frappe.msgprint(
							`⚠️ لم يتم إنشاء طلب عرض سعر للمورد ${supplier.name} لعدم وجود أصناف.`,
						);
						return;
					}

					// Create RFQ
					frappe.call({
						method: 'frappe.client.insert',
						args: { doc: rfq },
						callback: function (res) {
							if (res.message) {
								let rfq_link = `${window.location.origin}/app/request-for-quotation/${res.message.name}`;
								frappe.msgprint({
									title: '✅ تم إنشاء طلب عرض سعر',
									message: `المورد: <b>${supplier.name}</b><br>رابط: <a href="${rfq_link}" target="_blank">${res.message.name}</a>`,
									indicator: 'green',
								});

								// Get phone number from Contact linked to supplier
								if (supplier.supplier_primary_contact) {
									frappe.db
										.get_doc('Contact', supplier.supplier_primary_contact)
										.then((contact_doc) => {
											let phone_number = null;

											// Search in phone_nos table for first available number
											if (
												contact_doc.phone_nos &&
												contact_doc.phone_nos.length > 0
											) {
												phone_number = contact_doc.phone_nos[0].phone;
											}

											if (phone_number) {
												let sms_message =
													`📌 تم إنشاء طلب عرض سعر جديد (${res.message.name})\n` +
													`الرابط: ${rfq_link}`;
												frappe.call({
													method: 'frappe.core.doctype.sms_settings.sms_settings.send_sms',
													args: {
														receiver_list: [phone_number],
														msg: sms_message,
													},
													callback: function () {
														frappe.msgprint(
															`📨 تم إرسال رابط RFQ إلى المورد ${supplier.name} (${phone_number})`,
														);
													},
													error: function (err) {
														frappe.msgprint(
															`❌ فشل إرسال الرسالة إلى المورد ${supplier.name}.`,
														);
														console.error(err);
													},
												});
											} else {
												frappe.msgprint(
													`⚠️ لا يوجد رقم هاتف في Contact: ${supplier.supplier_primary_contact} للمورد ${supplier.name}.`,
												);
											}
										});
								} else {
									frappe.msgprint(
										`⚠️ لا يوجد Contact أساسي للمورد ${supplier.name}.`,
									);
								}
							}
						},
						error: function (err) {
							frappe.msgprint({
								title: '❌ فشل إنشاء طلب عرض سعر',
								message: `المورد: ${supplier.name}<br><pre>${JSON.stringify(
									err,
									null,
									2,
								)}</pre>`,
								indicator: 'red',
							});
						},
					});
				});
			});
	},
});

// ============================================
// File 22: reservation.js
// ============================================
frappe.ui.form.on('Sales Order Item', {
	item_code: function (frm, cdt, cdn) {
		let row = locals[cdt][cdn];

		if (!row.item_code) return;

		frappe.db.get_value('Item', row.item_code, 'is_sub_contracted_item').then((r) => {
			let is_sub = r.message.is_sub_contracted_item;

			// Enable reservation only if item is not subcontracted
			frappe.model.set_value(cdt, cdn, 'reserve_stock', !is_sub);
		});
	},
});

// ============================================
// File 23: reserved_qty.js
// ============================================
frappe.ui.form.on('Sales Order Item', {
	item_code: function (frm, cdt, cdn) {
		let row = locals[cdt][cdn];
		if (row.item_code) {
			frappe.call({
				method: 'frappe.client.get_value',
				args: {
					doctype: 'Bin',
					filters: {
						item_code: row.item_code,
						warehouse: row.warehouse,
					},
					fieldname: 'reserved_qty',
				},
				callback: function (r) {
					if (r.message) {
						frappe.model.set_value(
							cdt,
							cdn,
							'custom_reserved_qty',
							r.message.reserved_qty || 0,
						);
					} else {
						frappe.model.set_value(cdt, cdn, 'custom_reserved_qty', 0);
					}
				},
			});
		} else {
			frappe.model.set_value(cdt, cdn, 'custom_reserved_qty', 0);
		}
	},
});

// ============================================
// File 24: sales_order_3.js
// ============================================
frappe.ui.form.on('Sales Order', {
	validate: function (frm) {
		let errors = [];

		for (let row of frm.doc.custom_payment) {
			// Check if payment method exists and amount is missing
			if (row.mode_of_payment && (!row.amount || row.amount === 0)) {
				errors.push(__(`السطر #{0}: عند تحديد طريقة الدفع يجب إدخال المبلغ.`, [row.idx]));
			}

			// Check if amount exists and payment method is missing
			if (row.amount && (!row.mode_of_payment || row.mode_of_payment.trim() === '')) {
				errors.push(__(`السطر #{0}: عند إدخال المبلغ يجب تحديد طريقة الدفع.`, [row.idx]));
			}
		}

		if (errors.length > 0) {
			frappe.msgprint(errors.join('<br>'));
			frappe.validated = false;
		}
	},

	on_submit: function (frm) {
		const create_payment_entry = (row) => {
			frappe.call({
				method: 'frappe.client.get_value',
				args: {
					doctype: 'Mode of Payment',
					filters: { name: row.mode_of_payment },
					fieldname: 'custom_account',
				},
				callback: function (res) {
					let account = res.message && res.message.custom_account;

					if (!account) {
						frappe.msgprint(
							__(
								'لا يوجد حساب مخصص في "طريقة الدفع" "{0}". الرجاء التحقق من تعبئة الحقل "custom_account".',
								[row.mode_of_payment],
							),
						);
						return;
					}

					let payment_entry = {
						doctype: 'Payment Entry',
						payment_type: 'Receive',
						company: frm.doc.company,

						mode_of_payment: row.mode_of_payment,
						paid_amount: row.amount,
						received_amount: row.amount,

						paid_to: account,
						paid_from: frm.doc.debit_to || '',

						posting_date: frm.doc.transaction_date,
						party_type: 'Customer',
						party: frm.doc.customer || '',

						reference_no: row.reference_no || '',
						reference_date: frm.doc.transaction_date,

						references: [
							{
								reference_doctype: 'Sales Order',
								reference_name: frm.doc.name,
								total_amount: frm.doc.grand_total,
								outstanding_amount: row.amount,
								allocated_amount: row.amount,
							},
						],
					};

					frappe.call({
						method: 'frappe.client.insert',
						args: { doc: payment_entry },
						callback: function (r) {
							if (r.message) {
								frappe.call({
									method: 'frappe.client.submit',
									args: { doc: r.message },
									callback: function (submit_r) {
										if (submit_r.message) {
											frappe.msgprint(
												__('تم إنشاء سند الدفع {0} للمبلغ {1}.', [
													submit_r.message.name,
													format_currency(row.amount, frm.doc.currency),
												]),
											);
										}
									},
								});
							}
						},
					});
				},
			});
		};

		frm.doc.custom_payment.forEach(create_payment_entry);
	},
});

// ============================================
// File 25: sales_order_insurance_data.js
// ============================================
frappe.ui.form.on('Sales Order', {
	customer: function (frm) {
		if (frm.doc.customer) {
			frappe.call({
				method: 'frappe.client.get',
				args: {
					doctype: 'Customer',
					name: frm.doc.customer,
				},
				callback: function (response) {
					if (
						response.message &&
						response.message.custom_insurance_data &&
						response.message.custom_insurance_data.length > 0
					) {
						// Check if custom_insurance_data field exists in the form (it depends on order_type == "Insurance")
						if (!frm.fields_dict.custom_insurance_data) {
							return;
						}

						let insurance_rows = response.message.custom_insurance_data;
						let last_row = insurance_rows[insurance_rows.length - 1];

						frm.clear_table('custom_insurance_data');

						let new_row = frm.add_child('custom_insurance_data');
						const fields_to_copy = [
							'policy_number',
							'category',
							'expiry_date',
							'category_name',
							'id_number',
							'category_type',
							'membership_number',
							'nationality',
							'Age',
							'file_number',
						];
						for (let key of fields_to_copy) {
							new_row[key] = last_row[key];
						}

						frm.refresh_field('custom_insurance_data');
					}
				},
			});
		}
	},

	on_submit: function (frm) {
		if (
			frm.doc.customer &&
			frm.doc.custom_insurance_data &&
			frm.doc.custom_insurance_data.length > 0
		) {
			let sales_row = frm.doc.custom_insurance_data[0];

			frappe.call({
				method: 'frappe.client.get',
				args: {
					doctype: 'Customer',
					name: frm.doc.customer,
				},
				callback: function (response) {
					let customer = response.message;
					if (customer) {
						let insurance_rows = customer.custom_insurance_data || [];
						let last_customer_row =
							insurance_rows.length > 0
								? insurance_rows[insurance_rows.length - 1]
								: null;

						const fields_to_check = [
							'policy_number',
							'category',
							'expiry_date',
							'category_name',
							'id_number',
							'category_type',
							'membership_number',
							'nationality',
							'Age',
							'file_number',
						];

						let is_different = true;

						if (last_customer_row) {
							is_different = false;

							for (let key of fields_to_check) {
								// Clean values before comparison
								let val1 = sales_row[key];
								let val2 = last_customer_row[key];

								if (val1 === undefined || val1 === null) val1 = '';
								if (val2 === undefined || val2 === null) val2 = '';

								// If it's a string, apply trim and case-insensitive comparison
								if (typeof val1 === 'string') val1 = val1.trim().toLowerCase();
								if (typeof val2 === 'string') val2 = val2.trim().toLowerCase();

								if (val1 !== val2) {
									is_different = true;
									break;
								}
							}
						}

						if (is_different) {
							let new_row = {};
							for (let key of fields_to_check) {
								new_row[key] = sales_row[key];
							}

							insurance_rows.push(new_row);

							frappe.call({
								method: 'frappe.client.set_value',
								args: {
									doctype: 'Customer',
									name: frm.doc.customer,
									fieldname: {
										custom_insurance_data: insurance_rows,
									},
								},
								callback: function () {},
							});
						}
					}
				},
			});
		}
	},
});

// ============================================
// File 26: sales_order_script.js
// ============================================
frappe.ui.form.on('Sales Order', {
	validate: async function (frm) {
		if (frm.doc.order_type !== 'Insurance') return;

		try {
			if (frm.doc.custom_insurance_company) {
				let doc = await frappe.db.get_doc(
					'Insurance Company',
					frm.doc.custom_insurance_company,
				);
				if (doc.custom__apvd_amt2 == 1) {
					await recalculate_insurance_amounts_v1(frm);
					return;
				}
			}

			if (frm.doc.custom_insurance_company) {
				let doc = await frappe.db.get_doc(
					'Insurance Company',
					frm.doc.custom_insurance_company,
				);
				if (doc.custom__apvd_amt == 1) {
					await recalculate_insurance_amounts_v2(frm);
					return;
				}
			}
		} catch (error) {
			console.error('Error in insurance calculation:', error);
			await recalculate_insurance_amounts_v2(frm);
		}

		if (frm.doc.custom_insurance_percentage === 0) {
			frm.set_value('custom_customer_amount', 0);
			frm.set_value('custom_company_amount', 0);
			frm.set_value('discount_amount', 0);
		}
	},

	custom_insurance_percentage: function (frm) {
		if (frm.doc.order_type !== 'Insurance') return;

		if (frm.doc.custom_insurance_percentage === 0) {
			frm.set_value('custom_customer_amount', 0);
			frm.set_value('custom_company_amount', 0);
			frm.set_value('discount_amount', 0);
		}
	},

	custom_maximum_limit: function (frm) {
		if (frm.doc.order_type !== 'Insurance') return;

		if (frm.doc.custom_insurance_percentage === 0) {
			frm.set_value('custom_customer_amount', 0);
			frm.set_value('custom_company_amount', 0);
			frm.set_value('discount_amount', 0);
		}
	},

	custom_approval_amount: function (frm) {
		if (frm.doc.order_type !== 'Insurance') return;

		if (frm.doc.custom_insurance_percentage === 0) {
			frm.set_value('custom_customer_amount', 0);
			frm.set_value('custom_company_amount', 0);
			frm.set_value('discount_amount', 0);
		}
	},

	before_save: async function (frm) {
		if (frm.doc.order_type !== 'Insurance') return;

		try {
			frm.set_value('discount_amount', 0);

			if (frm.doc.custom_insurance_company) {
				let doc = await frappe.db.get_doc(
					'Insurance Company',
					frm.doc.custom_insurance_company,
				);
				if (doc.custom__apvd_amt2 == 1) {
					await recalculate_insurance_amounts_v1(frm);
					return;
				}
			}

			if (frm.doc.custom_insurance_company) {
				let doc = await frappe.db.get_doc(
					'Insurance Company',
					frm.doc.custom_insurance_company,
				);
				if (doc.custom__apvd_amt == 1) {
					await recalculate_insurance_amounts_v2(frm);
					return;
				}
			}
		} catch (error) {
			console.error('Error in before_save:', error);
			await recalculate_insurance_amounts_v2(frm);
		}
	},
});

// ============================================
// Discount Percentage Validation Before Save
// ============================================
frappe.ui.form.on('Sales Order', {
	before_save: async function (frm) {
		// Check discount percentage for all items before save
		if (!frm.doc.items || frm.doc.items.length === 0) return;
		if (!frm.doc.selling_price_list) return;

		const validation_promises = frm.doc.items.map(async (row) => {
			if (!row.item_code) return null;

			try {
				// Get item max discount from Item Price
				const item_price = await frappe.db.get_value(
					'Item Price',
					{
						item_code: row.item_code,
						price_list: frm.doc.selling_price_list,
					},
					'custom_discount_percent',
				);

				const max_discount = +item_price.message?.custom_discount_percent || 0;

				// Get employee discount limit
				const employee_res = await frappe.call({
					method: 'frappe.client.get_list',
					args: {
						doctype: 'Employee',
						filters: {
							user_id: frappe.session.user,
							status: 'Active',
						},
						fields: ['custom_discount_percentage_limit'],
						limit_page_length: 1,
					},
				});

				const employee_limit =
					+employee_res.message?.[0]?.custom_discount_percentage_limit || 0;
				const allowed_limit = Math.max(max_discount, employee_limit);

				// Check if entered discount exceeds allowed limit
				const entered_discount = +row.custom_discount_percentage || 0;

				if (entered_discount > allowed_limit) {
					return {
						item_code: row.item_code,
						entered: entered_discount,
						allowed: allowed_limit,
					};
				}
			} catch (error) {
				console.error('Error validating discount for item:', row.item_code, error);
			}

			return null;
		});

		const validation_results = await Promise.all(validation_promises);
		const errors = validation_results.filter((r) => r !== null);

		if (errors.length > 0) {
			// Show immediate message before save for each item
			const error_messages = errors.map((err) => {
				return __('الصنف {0}: نسبة الخصم المدخلة ({1}%) - المسموح ({2}%)', [
					err.item_code,
					err.entered,
					err.allowed,
				]);
			});

			// Show message for each item with its allowed limit
			errors.forEach((err) => {
				frappe.msgprint({
					title: __('تحذير: نسبة الخصم تتجاوز المسموح'),
					message: __('عفوا إجمالي نسبة الخصم المسموحه هي {0}%', [err.allowed]),
					indicator: 'red',
				});
			});

			// Prevent save
			frappe.validated = false;
			throw new Error(__('لا يمكن الحفظ: نسبة الخصم تتجاوز المسموح'));
		}
	},
});

// Main code (depends on custom__apvd_amt2 == 1)
async function recalculate_insurance_amounts_v1(frm) {
	let insurance_company_name = frm.doc.custom_insurance_company;
	if (!insurance_company_name) return;

	let doc = await frappe.db.get_doc('Insurance Company', insurance_company_name);
	if (doc.custom__apvd_amt2 != 1) return;

	let percentage = frm.doc.custom_insurance_percentage || 0;
	let approval_amount = frm.doc.custom_approval_amount || 0;
	let maximum_limit = frm.doc.custom_maximum_limit || 0;
	let custom_contract_discount = frm.doc.custom_contract_discount || 0;

	if (percentage === 0) {
		frm.set_value('custom_customer_amount', 0);
		frm.set_value('custom_company_amount', 0);
		frm.set_value('discount_amount', 0);
		return;
	}

	let calculated_discount =
		(approval_amount - (approval_amount * custom_contract_discount) / 100) *
		(percentage / 100);
	let discount =
		maximum_limit > 0 ? Math.min(calculated_discount, maximum_limit) : calculated_discount;

	let adjusted_amount = approval_amount;
	let insurance_amount = adjusted_amount - approval_amount * (custom_contract_discount / 100);
	let final_insurance_amount = insurance_amount - discount;

	let insurance_difference = frm.doc.total - approval_amount;
	let total_customer_amount = discount + insurance_difference;

	let insurance_account_amount =
		frm.doc.taxes?.find((row) => row.account_head === '1302 - شركات التأمين - AO')
			?.tax_amount || 0;
	let negative_insurance_amount = insurance_account_amount * -1;
	let total_after_insurance = negative_insurance_amount + frm.doc.custom_customer_amount;
	let total_difference = frm.doc.total - total_after_insurance;

	frm.set_value('discount_amount', 0);
	frm.set_value('discount_amount', total_difference);

	if (final_insurance_amount > 0) {
		let negative_final_insurance_amount = final_insurance_amount * -1;
		let insurance_amount_row = frm.doc.taxes?.find(
			(row) => row.description === 'Insurance Amount',
		);
		if (!insurance_amount_row) {
			frm.add_child('taxes', {
				charge_type: 'Actual',
				account_head: '1302 - شركات التأمين - AO',
				description: 'Insurance Amount',
				tax_amount: negative_final_insurance_amount,
			});
		} else {
			insurance_amount_row.tax_amount = negative_final_insurance_amount;
			insurance_amount_row.account_head = '1302 - شركات التأمين - AO';
		}
	}

	frm.refresh_field('taxes');
	let total_taxes_and_charges = frm.doc.taxes.reduce(
		(total, row) => total + (row.tax_amount || 0),
		0,
	);

	frm.set_value('total_taxes_and_charges', total_taxes_and_charges);
	frm.set_value('total', total_taxes_and_charges);
	frm.set_value('custom_company_amount', insurance_account_amount * -1);
	frm.set_value('custom_customer_amount', total_customer_amount);
}

// Alternative code (depends on custom__apvd_amt == 1)
async function recalculate_insurance_amounts_v2(frm) {
	let insurance_company_name = frm.doc.custom_insurance_company;
	if (!insurance_company_name) return;

	let doc = await frappe.db.get_doc('Insurance Company', insurance_company_name);
	if (doc.custom__apvd_amt != 1) return;

	let percentage = frm.doc.custom_insurance_percentage || 0;
	let approval_amount = frm.doc.custom_approval_amount || 0;
	let maximum_limit = frm.doc.custom_maximum_limit || 0;
	let custom_contract_discount = frm.doc.custom_contract_discount || 0;

	if (percentage === 0) {
		frm.set_value('custom_customer_amount', 0);
		frm.set_value('custom_company_amount', 0);
		frm.set_value('discount_amount', 0);
		return;
	}

	let calculated_discount = approval_amount * (percentage / 100);
	let discount =
		maximum_limit > 0 ? Math.min(calculated_discount, maximum_limit) : calculated_discount;

	let adjusted_amount = approval_amount - discount;
	let insurance_amount = adjusted_amount - adjusted_amount * (custom_contract_discount / 100);
	let final_insurance_amount = insurance_amount;

	let insurance_difference = frm.doc.total - approval_amount;
	let total_customer_amount = discount + insurance_difference;

	let insurance_account_amount =
		frm.doc.taxes?.find((row) => row.account_head === '1302 - شركات التأمين - AO')
			?.tax_amount || 0;
	let negative_insurance_amount = insurance_account_amount * -1;
	let total_after_insurance = negative_insurance_amount + frm.doc.custom_customer_amount;
	let total_difference = frm.doc.total - total_after_insurance;

	frm.set_value('discount_amount', 0);
	frm.set_value('discount_amount', total_difference);

	if (final_insurance_amount > 0) {
		let negative_final_insurance_amount = final_insurance_amount * -1;
		let insurance_amount_row = frm.doc.taxes?.find(
			(row) => row.description === 'Insurance Amount',
		);
		if (!insurance_amount_row) {
			frm.add_child('taxes', {
				charge_type: 'Actual',
				account_head: '1302 - شركات التأمين - AO',
				description: 'Insurance Amount',
				tax_amount: negative_final_insurance_amount,
			});
		} else {
			insurance_amount_row.tax_amount = negative_final_insurance_amount;
			insurance_amount_row.account_head = '1302 - شركات التأمين - AO';
		}
	}

	frm.refresh_field('taxes');
	let total_taxes_and_charges = frm.doc.taxes.reduce(
		(total, row) => total + (row.tax_amount || 0),
		0,
	);

	frm.set_value('total_taxes_and_charges', total_taxes_and_charges);
	frm.set_value('total', total_taxes_and_charges);
	frm.set_value('custom_company_amount', insurance_account_amount * -1);
	frm.set_value('custom_customer_amount', total_customer_amount);
}

// ============================================
// File 27: sales_order2.js
// ============================================
frappe.ui.form.on('Sales Order', {
	before_submit: function (frm) {
		if (frm.doc.customer && frm.doc.custom_size && frm.doc.custom_size.length > 0) {
			return frappe
				.call({
					method: 'frappe.client.get',
					args: {
						doctype: 'Customer',
						name: frm.doc.customer,
					},
				})
				.then((response) => {
					if (response.message) {
						let customer_doc = response.message;
						let existing_rows = customer_doc.custom_size_t || [];
						let updated_rows = [...existing_rows];
						let conflict_found = false;

						for (let so_row of frm.doc.custom_size) {
							// Ignore conflict if row date equals search date
							let is_from_search =
								frm.doc.custom_date && so_row.date === frm.doc.custom_date;

							if (!is_from_search) {
								let conflict = existing_rows.some(
									(row) => row.date === so_row.date && row.so !== frm.doc.name,
								);

								if (conflict) {
									frappe.msgprint({
										title: __('⚠️ تنبيه'),
										message:
											__(' 📝 ') +
											so_row.date +
											__(' هذا الكشف موجود مسبقاً '),
										indicator: 'red',
									});
									frappe.validated = false;
									conflict_found = true;
									break; // Stop iteration
								}
							}

							let row_data = {
								date: so_row.date,
								sphr: so_row.sphr,
								cylr: so_row.cylr,
								axisr: so_row.axisr,
								addr: so_row.addr,
								pdr: so_row.pdr,
								sphl: so_row.sphl,
								cyll: so_row.cyll,
								axisl: so_row.axisl,
								addl: so_row.addl,
								pdl: so_row.pdl,
								so: frm.doc.name,
							};

							let existing_index = updated_rows.findIndex(
								(r) => r.so === frm.doc.name && r.date === so_row.date,
							);

							if (existing_index !== -1) {
								updated_rows[existing_index] = {
									...updated_rows[existing_index],
									...row_data,
								};
							} else {
								updated_rows.push(row_data);
							}
						}

						// If no conflict, save to customer record
						if (!conflict_found) {
							return frappe.call({
								method: 'frappe.client.set_value',
								args: {
									doctype: 'Customer',
									name: frm.doc.customer,
									fieldname: {
										custom_size_t: updated_rows,
									},
								},
							});
						}
					}
				});
		}
	},
});

// ============================================
// File 28: search_in_old_eye_examination.js
// ============================================
frappe.ui.form.on('Sales Order', {
	custom_date: function (frm) {
		if (frm.doc.custom_date && frm.doc.customer) {
			frm.clear_table('custom_size');

			frappe.model.with_doc('Customer', frm.doc.customer, function () {
				let customer_doc = frappe.get_doc('Customer', frm.doc.customer);

				if (customer_doc && customer_doc.custom_size_t) {
					let found = false;
					customer_doc.custom_size_t.forEach((row) => {
						if (row.date == frm.doc.custom_date) {
							found = true;
							let child = frm.add_child('custom_size');
							child.date = row.date;
							child.sphr = row.sphr;
							child.cylr = row.cylr;
							child.axisr = row.axisr;
							child.addr = row.addr;
							child.pdr = row.pdr;
							child.sphl = row.sphl;
							child.cyll = row.cyll;
							child.axisl = row.axisl;
							child.addl = row.addl;
							child.pdl = row.pdl;
						}
					});

					frm.refresh_field('custom_size');

					if (found) {
						// Table is read-only
						frm.fields_dict['custom_size'].grid.df.cannot_add_rows = true;
						frm.fields_dict['custom_size'].grid.df.cannot_delete_rows = true;
						frm.fields_dict['custom_size'].grid.df.read_only = true;
						frm.fields_dict['custom_size'].grid.refresh();
					}
				}
			});
		} else {
			// When deleting date, clear table and make it editable with immediate update
			frm.clear_table('custom_size');
			frm.refresh_field('custom_size');

			frm.fields_dict['custom_size'].grid.df.cannot_add_rows = false;
			frm.fields_dict['custom_size'].grid.df.cannot_delete_rows = false;
			frm.fields_dict['custom_size'].grid.df.read_only = false;

			setTimeout(() => {
				frm.fields_dict['custom_size'].grid.refresh();
				frm.dirty();
				frm.refresh();
			}, 100);
		}
	},
});

// ============================================
// File 29: sms2.js
// ============================================
frappe.ui.form.on('Sales Order', {
	refresh: function (frm) {
		frm.add_custom_button('📤 إرسال الخصم الإضافي عبر SMS', async function () {
			let messages = [];
			let branch = frm.doc.branch || 'غير محدد';

			// Collect all items with unapproved discount
			(frm.doc.items || []).forEach((item) => {
				if (item.custom_discount2 > 0 && !item.custom_discount2_approved) {
					let subject =
						`👓️ خصم ${format_currency(
							item.custom_discount2,
							'SAR',
						)} ريال يتطلب الموافقة\n` +
						`الصنف: ${item.item_code}\n` +
						`كود الخصم: ${item.custom_discount_code || 'غير متوفر'}\n` +
						`الفرع: ${branch}`;
					messages.push(subject);
				}
			});

			if (!messages.length) {
				frappe.msgprint('❗ لا توجد خصومات غير معتمدة.');
				return;
			}

			// Get list of active employees
			frappe.db
				.get_list('Employee', {
					fields: ['name', 'employee_name'],
					filters: { status: 'Active' },
					limit: 100,
				})
				.then((employees) => {
					if (!employees.length) {
						frappe.msgprint('❗ لا يوجد موظفين نشطين.');
						return;
					}

					frappe.prompt(
						[
							{
								label: 'اختر الموظف',
								fieldname: 'employee',
								fieldtype: 'Link',
								options: 'Employee',
								reqd: 1,
							},
						],
						function (values) {
							// After selecting employee, get their phone number
							frappe.db
								.get_value('Employee', values.employee, 'cell_number')
								.then((res) => {
									const phone = res.message.cell_number;
									if (!phone) {
										frappe.msgprint('❗ لا يوجد رقم جوال محفوظ لهذا الموظف.');
										return;
									}

									let sales_order_link = `${
										window.location.origin
									}/app/sales-order/${encodeURIComponent(frm.doc.name)}`;
									let full_message =
										messages.join('\n\n') +
										`\n\n📌 رابط الطلب:\n${sales_order_link}`;
									let phone_list = [phone.trim()];

									frappe.call({
										method: 'frappe.core.doctype.sms_settings.sms_settings.send_sms',
										args: {
											receiver_list: phone_list,
											msg: full_message,
										},
										callback: function (res) {
											frappe.msgprint(
												'📨 تم إرسال الرسالة بنجاح إلى الموظف.',
											);
										},
										error: function (err) {
											frappe.msgprint(
												'❌ فشل إرسال الرسالة. تحقق من إعدادات SMS.',
											);
											console.error(err);
										},
									});
								});
						},
					);
				});
		});
	},
});

// ============================================
// File 30: stock_entry.js
// ============================================

frappe.ui.form.on('Sales Order', {
	async after_save(frm) {
		if (!frm.doc.custom_quotation) return;

		try {
			// Get latest version of document
			await frm.refresh();

			const quotation = await frappe.db.get_doc('Quotation', frm.doc.custom_quotation);

			if (quotation.custom_material_request_status === 'تم إصدار طلب المواد') return;

			const target_warehouse = quotation.custom_default_source_warehouse;
			if (!target_warehouse) {
				frappe.msgprint('⚠️ يجب تحديد المستودع الرئيسي في Quotation.');
				return;
			}

			// Get available quantities
			const bin_data = await frappe.db.get_list('Bin', {
				filters: {
					warehouse: target_warehouse,
					item_code: ['in', (quotation.items || []).map((i) => i.item_code)],
				},
				fields: ['item_code', 'actual_qty', 'reserved_qty'],
			});

			const available_map = {};
			(bin_data || []).forEach((b) => {
				const actual = b.actual_qty || 0;
				const reserved = b.reserved_qty || 0;
				available_map[b.item_code] = actual - reserved;
			});

			// Calculate total required quantity
			const total_required = {};
			(quotation.items || []).forEach((item) => {
				if (item.warehouse && item.warehouse !== target_warehouse) {
					total_required[item.item_code] =
						(total_required[item.item_code] || 0) + item.qty;
				}
			});

			// Calculate remaining shortage
			const shortage_map = {};
			Object.keys(total_required).forEach((item_code) => {
				const available = available_map[item_code] || 0;
				shortage_map[item_code] = Math.max(total_required[item_code] - available, 0);
			});

			// Distribute shortage across warehouses
			const warehouse_groups = {};
			(quotation.items || []).forEach((item) => {
				if (item.warehouse && item.warehouse !== target_warehouse) {
					let shortage_left = shortage_map[item.item_code] || 0;
					if (shortage_left > 0) {
						const use_qty = Math.min(item.qty, shortage_left);
						if (use_qty > 0) {
							if (!warehouse_groups[item.warehouse])
								warehouse_groups[item.warehouse] = [];
							warehouse_groups[item.warehouse].push({
								item_code: item.item_code,
								qty: use_qty,
								uom: item.uom,
							});
							shortage_map[item.item_code] -= use_qty;
						}
					}
				}
			});

			const warehouses = Object.keys(warehouse_groups);
			if (warehouses.length === 0) {
				frappe.msgprint(
					'✅ لا توجد أصناف تحتاج نقل (الكميات متوفرة في المستودع الرئيسي).',
				);
				return;
			}

			// Create transfer entries
			for (const from_warehouse of warehouses) {
				const warehouse_info = await frappe.db.get_value(
					'Warehouse',
					from_warehouse,
					'default_in_transit_warehouse',
				);

				if (
					!warehouse_info ||
					!warehouse_info.message ||
					!warehouse_info.message.default_in_transit_warehouse
				) {
					frappe.throw(`❌ المستودع ${from_warehouse} ليس لديه Transit Warehouse معرف.`);
				}

				const transit_warehouse = warehouse_info.message.default_in_transit_warehouse;
				const items = warehouse_groups[from_warehouse];

				// Create transfer entry
				const se_doc = await frappe.call({
					method: 'frappe.client.insert',
					args: {
						doc: {
							doctype: 'Stock Entry',
							stock_entry_type: 'Material Transfer',
							company: frm.doc.company,
							sales_order: frm.doc.name,
							custom_sales_order: frm.doc.name,
							items: items.map((item) => ({
								item_code: item.item_code,
								qty: item.qty,
								uom: item.uom,
								s_warehouse: from_warehouse,
								t_warehouse: transit_warehouse,
							})),
							from_warehouse: from_warehouse,
							to_warehouse: transit_warehouse,
							add_to_transit: 1,
							custom_final_target_warehouse: target_warehouse,
						},
					},
				});

				// Submit transfer entry
				const submitted_se = await frappe.call({
					method: 'frappe.client.submit',
					args: { doc: se_doc.message },
				});

				const se_name = submitted_se.message.name;

				// Update Sales Order Items
				for (const row of frm.doc.items || []) {
					const matched_item = items.find((i) => i.item_code === row.item_code);
					if (matched_item) {
						await frappe.db.set_value(
							'Sales Order Item',
							row.name,
							'custom_stock_entry',
							se_name,
						);
					}
				}

				// Update Quotation status
				await frappe.call({
					method: 'frappe.client.set_value',
					args: {
						doctype: 'Quotation',
						name: quotation.name,
						fieldname: { custom_material_request_status: 'تم إصدار طلب المواد' },
					},
				});

				frappe.msgprint({
					title: __('تم إنشاء سند تحويل مخزون'),
					indicator: 'green',
					message: __(
						'✅ تم إنشاء سند تحويل جديد: <a href="/app/stock-entry/{0}" target="_blank">{0}</a>',
						[se_name],
					),
				});
			}

			// Refresh form to get latest changes
			await frm.refresh();
		} catch (error) {
			console.error('Error in after_save:', error);
			frappe.msgprint({
				title: __('خطأ'),
				indicator: 'red',
				message: __('حدث خطأ أثناء معالجة طلب المواد: {0}', [error.message]),
			});
		}
	},
});

// ============================================
// File 31: stock_table_so.js
// ============================================
// =======================
// Sales Order Form Event Handlers
// Handles initialization, refresh, and save events for strict color coding
// =======================
frappe.ui.form.on('Sales Order', {
	onload_post_render(frm) {
		// Apply colors for all document statuses (draft, submitted, cancelled)
		init_strict_colors(frm);
	},
	refresh(frm) {
		// Apply colors for all document statuses (draft, submitted, cancelled)
		frappe.after_ajax(() => {
			setTimeout(() => {
				init_strict_colors(frm);
			}, 100);
		});
	},
	before_save(frm) {
		// Apply colors for all document statuses (draft, submitted, cancelled)
		apply_strict_colors(frm);
	},
});

// =======================
// Initialize strict colors and bind grid events
// =======================
function init_strict_colors(frm) {
	apply_strict_colors(frm);

	// Bind grid row render event on form wrapper (Frappe framework standard)
	if (frm.fields_dict['items'] && !frm._strict_grid_hooked) {
		frm._strict_grid_hooked = true;

		// Use frm.wrapper for grid-row-render event (Frappe framework standard)
		$(frm.wrapper).on('grid-row-render', function (e, grid_row) {
			// Only process rows from items grid
			// Apply colors for all document statuses (draft, submitted, cancelled)
			if (
				grid_row &&
				grid_row.grid &&
				grid_row.grid.df &&
				grid_row.grid.df.fieldname === 'items'
			) {
				color_single_row(grid_row);
			}
		});
	}
}

// =======================
// Apply strict colors to all grid rows
// Iterates through all existing rows and applies color coding
// =======================
function apply_strict_colors(frm) {
	// Apply colors for all document statuses (draft, submitted, cancelled)
	inject_strict_css();

	if (frm.fields_dict['items']) {
		frm.fields_dict['items'].grid.wrapper.find('.grid-row').each(function () {
			let grid_row = $(this).data('grid_row');
			if (grid_row) color_single_row(grid_row);
		});
	}
}

// =======================
// Apply color coding rules to a single grid row
// Green: sufficient stock in warehouse, Yellow: sufficient in company but not warehouse, Red: insufficient
// =======================
function color_single_row(grid_row) {
	if (!grid_row || !grid_row.doc) return;

	const row = grid_row.doc;
	const $actual = $(grid_row.row).find('[data-fieldname="projected_qty"]');

	if (!row.item_code || !row.warehouse) return;
	if (!cur_frm || !cur_frm.doc || !cur_frm.doc.items) return;

	const total_required_qty = cur_frm.doc.items
		.filter((r) => r.item_code === row.item_code)
		.reduce((sum, r) => sum + (r.qty || 0), 0);

	const available_in_wh = row.projected_qty || 0;

	frappe.call({
		method: 'frappe.client.get_list',
		args: { doctype: 'Bin', filters: { item_code: row.item_code }, fields: ['projected_qty'] },
		callback: function (r) {
			const bins = r.message || [];
			const total_available = bins.reduce((sum, b) => sum + (b.projected_qty || 0), 0);

			$actual.removeClass('strict-red strict-green strict-yellow');
			let tooltip = `إجمالي المطلوب: ${total_required_qty}\nمتاح بالمخزن: ${available_in_wh}\nإجمالي بالشركة: ${total_available}`;

			if (total_required_qty <= available_in_wh) $actual.addClass('strict-green');
			else if (total_required_qty > available_in_wh && total_available >= total_required_qty)
				$actual.addClass('strict-yellow');
			else {
				$actual.addClass('strict-red');
				tooltip = 'الصنف غير متوفر بالشركة';
			}

			$actual.attr('title', tooltip);
			$actual.css('cursor', 'pointer');

			$actual.off('click.stockDialog').on('click.stockDialog', function () {
				if (grid_row._dialog_opened) return;
				grid_row._dialog_opened = true;
				open_stock_dialog(cur_frm, grid_row);
				frappe.after_ajax(() => {
					setTimeout(() => (grid_row._dialog_opened = false), 500);
				});
			});
		},
	});
}

// =======================
// Inject CSS styles for strict color coding
// Adds styles for red, green, and yellow background colors
// =======================
function inject_strict_css() {
	if (!document.getElementById('strict-item-color-style')) {
		const style = document.createElement('style');
		style.id = 'strict-item-color-style';
		style.innerHTML = `
            .strict-red, .strict-red input { background-color: #FF3333 !important; color: #000 !important; }
            .strict-green, .strict-green input { background-color: #00C000 !important; color: #000 !important; }
            .strict-yellow, .strict-yellow input { background-color: #FFFF66 !important; color: #000 !important; }
        `;
		document.head.appendChild(style);
	}
}

// =======================
// Open stock dialog showing warehouse balances
// Displays available stock in all warehouses for the selected item
// Works in any document status (draft, submitted, cancelled)
// =======================
function open_stock_dialog(frm, grid_row) {
	const row = grid_row.doc;
	if (!row.item_code) {
		frappe.msgprint(__('الرجاء اختيار الصنف أولاً'));
		return;
	}

	frappe.call({
		method: 'frappe.client.get_list',
		args: {
			doctype: 'Bin',
			filters: { item_code: row.item_code },
			fields: ['warehouse', 'projected_qty'],
			order_by: 'warehouse',
		},
		callback: function (r) {
			const list = (r.message || []).filter(
				(d) => !d.warehouse.toLowerCase().includes('transit'),
			);
			if (!list.length) {
				frappe.msgprint(
					__('لا يوجد رصيد مسجل لهذا الصنف في أي مخزن (باستثناء مخازن الترانزيت)'),
				);
				return;
			}

			let total = 0;
			let rows_html = list
				.map((d) => {
					const wh = frappe.utils.escape_html(d.warehouse || '');
					const projected_qty = d.projected_qty || 0;
					total += projected_qty;
					const qty_style = projected_qty <= 0 ? ' style="color:red;"' : '';

					let stock_entry_cell = '-';
					if (row.custom_stock_entry && row.custom_stock_entry.trim() !== '') {
						frappe.call({
							method: 'frappe.client.get',
							args: { doctype: 'Stock Entry', name: row.custom_stock_entry },
							async: false,
							callback: function (se) {
								const source_wh = se.message.from_warehouse || '';
								if (source_wh === wh) {
									stock_entry_cell = `<a href="/app/stock-entry/${row.custom_stock_entry}">${row.custom_stock_entry}</a>`;
								}
							},
						});
					}

					const action_btn = `<button class="btn btn-xs btn-primary create-stock-entry" data-warehouse="${wh}">قيد مخزني</button>`;

					return `<tr data-warehouse="${wh}">
                            <td>${wh}</td>
                            <td${qty_style}>${projected_qty}</td>
                            <td class="stock-entry-no">${stock_entry_cell}</td>
                            <td>${action_btn}</td>
                        </tr>`;
				})
				.join('');

			const html = `
                <table class="table table-bordered custom-stock-table">
                    <thead><tr><th>المخزن</th><th>الكمية المتاحة</th><th>رقم قيد المخزون</th><th>إجراء</th></tr></thead>
                    <tbody>${rows_html}</tbody>
                    <tfoot><tr><th>الإجمالي المتاح</th><th>${total}</th><th colspan="2"></th></tr></tfoot>
                </table>
            `;

			const d = new frappe.ui.Dialog({
				title: 'أرصدة المخازن للصنف: ' + row.item_code,
				fields: [{ fieldtype: 'HTML', fieldname: 'stock_html' }],
				primary_action_label: 'إغلاق',
				primary_action() {
					d.hide();
				},
				size: 'large',
			});

			d.fields_dict.stock_html.$wrapper.html(html);

			$(`<style>
                .custom-stock-table thead { background-color: #f0f0f0; color: #000; font-weight: bold; }
                .custom-stock-table tfoot { background-color: #f0f0f0; color: #000; font-weight: bold; }
                .custom-stock-table td, .custom-stock-table th { padding: 6px 8px; vertical-align: middle; }
                .create-stock-entry { margin-left: 8px; }
            </style>`).appendTo(d.$wrapper);

			// Button to create Stock Entry with quotation link validation
			d.$wrapper.find('.create-stock-entry').on('click', function (e) {
				e.stopPropagation();
				const wh = $(this).attr('data-warehouse');
				const row_current = frappe.get_doc(row.doctype, row.name);

				// Check if order is linked to quotation and stock entry not created yet
				if (row_current.prevdoc_docname && !row_current.custom_stock_entry) {
					frappe.msgprint(
						__('لا يمكن إنشاء قيد المخزون لأن أمر البيع مرتبط بعرض سعر: {0}', [
							row_current.prevdoc_docname,
						]),
					);
					return;
				}

				// If stock entry already exists
				if (
					row_current.custom_stock_entry &&
					row_current.custom_stock_entry.trim() !== ''
				) {
					frappe.msgprint(
						__('هناك قيد مخزني مسجل مسبقًا لهذا الصنف: {0}', [
							row_current.custom_stock_entry,
						]),
					);
					return;
				}

				const bin_data = list.find((d) => d.warehouse === wh);
				const projected_qty = bin_data?.projected_qty || 0;

				if (projected_qty <= 0) frappe.msgprint(__('الرصيد غير كافي لإنشاء قيد مخزني'));
				else create_stock_entry(frm, row_current, wh, d);
			});

			d.show();
		},
	});
}

// =======================
// Create Stock Entry with one-time deduction per item
// Creates a material transfer entry and marks the item as deducted
// =======================
function create_stock_entry(frm, row, from_warehouse, dialog) {
	const qty = row.qty || 0;
	if (!qty || qty <= 0) {
		frappe.msgprint(__('لا يوجد كمية صالحة لإصدار قيد مخزني'));
		return;
	}

	// Check if quantity was deducted for any other row of the same item
	const item_already_deducted = frm.doc.items.some(
		(i) => i.item_code === row.item_code && i.custom_stock_entry_deducted,
	);

	const qty_to_transfer = item_already_deducted ? row.qty : row.qty - (row.projected_qty || 0);

	frappe.call({
		method: 'frappe.client.get_value',
		args: {
			doctype: 'Warehouse',
			filters: { name: from_warehouse },
			fieldname: 'default_in_transit_warehouse',
		},
		callback: function (r) {
			const to_warehouse = r.message?.default_in_transit_warehouse;
			if (!to_warehouse) {
				frappe.msgprint(__('المخزن المصدر لا يحتوي على مخزن وجهة افتراضي'));
				return;
			}

			frappe.call({
				method: 'frappe.client.insert',
				args: {
					doc: {
						doctype: 'Stock Entry',
						stock_entry_type: 'Material Transfer',
						from_warehouse: from_warehouse,
						to_warehouse: to_warehouse,
						custom_sales_order: frm.doc.name,
						custom_final_target_warehouse: row.warehouse,
						add_to_transit: 1,
						items: [
							{
								item_code: row.item_code,
								qty: qty_to_transfer,
								s_warehouse: from_warehouse,
								t_warehouse: to_warehouse,
							},
						],
					},
				},
				callback: function (res) {
					if (res.message) {
						frappe.call({
							method: 'frappe.client.submit',
							args: { doc: res.message },
							callback: function (submit_res) {
								const entry_no = submit_res.message.name;
								frappe.model.set_value(
									row.doctype,
									row.name,
									'custom_stock_entry',
									entry_no,
								);

								// Mark row that deduction was made if this is the first time
								if (!item_already_deducted) {
									frappe.model.set_value(
										row.doctype,
										row.name,
										'custom_stock_entry_deducted',
										1,
									);
								}

								// If custom table exists, don't use refresh_field as updates happen directly
								if (!frm.fields_dict.custom_items_table) {
									frm.refresh_field('items');
								}
								frappe.msgprint(__('تم إنشاء قيد مخزني مسجل: {0}', [entry_no]));

								if (dialog)
									dialog.$wrapper
										.find(
											`tr[data-warehouse="${from_warehouse}"] .stock-entry-no`,
										)
										.html(
											`<a href="/app/stock-entry/${entry_no}">${entry_no}</a>`,
										);
							},
						});
					}
				},
			});
		},
	});
}

// =======================
// Sales Order Item field change handlers
// Triggers color refresh when item fields are changed
// Apply colors for all document statuses (draft, submitted, cancelled)
// =======================
frappe.ui.form.on('Sales Order Item', {
	item_code: function (frm, cdt, cdn) {
		setTimeout(() => apply_strict_colors(frm), 200);
	},
	warehouse: function (frm, cdt, cdn) {
		setTimeout(() => apply_strict_colors(frm), 200);
	},
	projected_qty: function (frm, cdt, cdn) {
		apply_strict_colors(frm);
	},
	qty: function (frm, cdt, cdn) {
		setTimeout(() => apply_strict_colors(frm), 200);
	},
});

// ============================================
// File 32: tolal_items_discount.js
// ============================================
// Total discount in item table (Sales Order)

frappe.ui.form.on('Sales Order', {
	validate: function (frm) {
		update_all_discounts(frm);
	},
});

// Update when any values change in items table
frappe.ui.form.on('Sales Order Item', {
	custom_discount: function (frm, cdt, cdn) {
		update_discount_detailed(frm, cdt, cdn);
	},
	custom_discount_percentage: function (frm, cdt, cdn) {
		update_discount_detailed(frm, cdt, cdn);
	},
	custom_discount2: function (frm, cdt, cdn) {
		update_discount_detailed(frm, cdt, cdn);
	},
	price_list_rate: function (frm, cdt, cdn) {
		update_discount_detailed(frm, cdt, cdn);
	},
	qty: function (frm, cdt, cdn) {
		update_discount_detailed(frm, cdt, cdn);
	},
});

// Function from tolal_items_discount.js - Detailed discount calculation (divides by qty)
function update_discount_detailed(frm, cdt, cdn) {
	let row = locals[cdt][cdn];

	// First discount (custom_discount ÷ qty)
	let val1 = 0;
	if (row.custom_discount && row.qty) {
		val1 = flt(row.custom_discount) / flt(row.qty);
	}

	// Second discount (price_list_rate * percentage / 100)
	let val2 = 0;
	if (row.price_list_rate && row.custom_discount_percentage) {
		val2 = (flt(row.price_list_rate) * flt(row.custom_discount_percentage)) / 100;
	}

	// Third discount (custom_discount2 ÷ qty)
	let val3 = 0;
	if (row.custom_discount2 && row.qty) {
		val3 = flt(row.custom_discount2) / flt(row.qty);
	}

	// Sum of all three discounts
	let total_discount = val1 + val2 + val3;

	frappe.model.set_value(cdt, cdn, 'discount_amount', total_discount);

	frm.dirty();
}

// Update all rows only on save
function update_all_discounts(frm) {
	(frm.doc.items || []).forEach((row) => {
		let val1 = 0;
		if (row.custom_discount && row.qty) {
			val1 = flt(row.custom_discount) / flt(row.qty);
		}

		let val2 = 0;
		if (row.price_list_rate && row.custom_discount_percentage) {
			val2 = (flt(row.price_list_rate) * flt(row.custom_discount_percentage)) / 100;
		}

		let val3 = 0;
		if (row.custom_discount2 && row.qty) {
			val3 = flt(row.custom_discount2) / flt(row.qty);
		}

		frappe.model.set_value(row.doctype, row.name, 'discount_amount', val1 + val2 + val3);
	});
}

// ============================================
// File 33: total_deduction.js
// ============================================
// Update total discount in Sales Order

frappe.ui.form.on('Sales Order Item', {
	discount_amount: function (frm, cdt, cdn) {
		update_total_deduction(frm);
	},
	qty: function (frm, cdt, cdn) {
		update_total_deduction(frm);
	},
});

frappe.ui.form.on('Sales Order', {
	onload: function (frm) {
		update_total_deduction(frm);
	},
	refresh: function (frm) {
		// Only update in refresh if document is already dirty or is new
		// This prevents marking clean documents as dirty
		if (frm.is_dirty() || frm.doc.__islocal) {
			update_total_deduction(frm);
		}
	},
});

function update_total_deduction(frm) {
	let total_deduction = 0;

	(frm.doc.items || []).forEach((item) => {
		let discount = (item.discount_amount || 0) * (item.qty || 0);
		total_deduction += discount;
	});

	// Only update if value has changed to prevent marking document as dirty
	let current_value = flt(frm.doc.custom_total_deduction || 0);
	if (Math.abs(current_value - total_deduction) > 0.01) {
		// Use frappe.model.set_value to avoid triggering dirty state unnecessarily
		// Only if document is already dirty or new
		if (frm.is_dirty() || frm.doc.__islocal) {
			frm.set_value('custom_total_deduction', total_deduction);
		} else {
			// For clean documents, update silently without marking as dirty
			frm.doc.custom_total_deduction = total_deduction;
		}
	}
}

// ============================================
// File 34: total_insurance.js
// ============================================
frappe.ui.form.on('Sales Order', {
	onload(frm) {
		// Make fields read-only when form loads
		frm.set_df_property('custom_customer_amount', 'read_only', 1);
		frm.set_df_property('custom_company_amount', 'read_only', 1);
		frm.set_df_property('custom_total_insurance', 'read_only', 1);
	},
	custom_customer_amount(frm) {
		calculate_total_insurance(frm);
	},
	custom_company_amount(frm) {
		calculate_total_insurance(frm);
	},
});

function calculate_total_insurance(frm) {
	const customer_amount = frm.doc.custom_customer_amount || 0;
	const company_amount = frm.doc.custom_company_amount || 0;
	frm.set_value('custom_total_insurance', customer_amount + company_amount);
}

// ============================================
// File 35: total_price_list_rate.js
// ============================================
frappe.ui.form.on('Sales Order', {
	validate: function (frm) {
		let total = 0;
		(frm.doc.items || []).forEach((row) => {
			row.custom_total_price_list = (row.price_list_rate || 0) * (row.qty || 0);
			total += row.custom_total_price_list;
		});
		frm.set_value('custom_total_table', total);
	},
});

frappe.ui.form.on('Sales Order Item', {
	price_list_rate: function (frm, cdt, cdn) {
		recalc_row_and_total(frm, cdt, cdn);
	},
	qty: function (frm, cdt, cdn) {
		recalc_row_and_total(frm, cdt, cdn);
	},
});

function recalc_row_and_total(frm, cdt, cdn) {
	let row = frappe.get_doc(cdt, cdn);
	row.custom_total_price_list = (row.price_list_rate || 0) * (row.qty || 0);

	let total = 0;
	(frm.doc.items || []).forEach((r) => {
		total += r.custom_total_price_list || 0;
	});
	frm.set_value('custom_total_table', total);
	frm.refresh_field('custom_total_table');
}
