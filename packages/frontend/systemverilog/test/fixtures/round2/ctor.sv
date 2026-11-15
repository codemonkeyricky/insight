class base_c;
  function new(int v);
  endfunction
endclass

class child_c extends base_c;
  function new();
    super.new(3);
  endfunction
  function new(int v);
    super.new();
  endfunction
  task run_it();
    base_c obj;
    base_c decl = new(4);
    unknown_t bi;
    obj = new(1);
    bi = new(2);
    obj2 = base_c::type_id::create("n");
  endtask
endclass
